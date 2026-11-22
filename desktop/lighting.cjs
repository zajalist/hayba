const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

// One live MCP connection per review keeps the editor's connection-bound approval valid.
// The main process owns project-mode selection and all write decisions.
class LightingSession {
  constructor(mcp, chat, publish, project) {
    this.project = project;
    this.mcp = mcp;
    this.chat = chat;
    this.publish = publish;
    this.controller = new AbortController();
  }
  close() {
    this.controller.abort();
    return this.mcp.close();
  }
  save(fields) {
    this.controller.signal.throwIfAborted();
    Object.assign(this.record, fields);
    this.publish();
  }
  async inspect(first, second) {
    const snap = await this.mcp.call('lighting_inspect_pair', { first, second });
    this.controller.signal.throwIfAborted();
    if (!Array.isArray(snap.lights) || snap.lights.length !== 2 || snap.lights[0].id === snap.lights[1].id)
      throw Error('Unreal did not return two distinct lights.');
    this.record = {
      project: this.project,
      id: randomUUID(),
      status: 'inspected',
      map: snap.map,
      baseline: snap.lights,
      observed: snap.lights,
    };
    this.chat.messages.push({
      id: this.chat.messages.length,
      role: 'assistant',
      text: 'Lighting inspection',
      lighting: this.record,
    });
    this.chat.updatedAt = new Date().toISOString();
    this.publish();
    return this.record;
  }
  propose(id, target, intensity) {
    const r = this.record;
    if (!r || id !== r.id || !['inspected', 'declined', 'undone'].includes(r.status))
      throw Error('Inspect both lights before proposing a change.');
    const light = r.baseline.find((item) => item.id === target);
    const value = Math.fround(intensity);
    if (!light || typeof intensity !== 'number' || !Number.isFinite(value) || value < 0 || value === light.intensity)
      throw Error('Choose an inspected light and a different, finite, nonnegative intensity.');
    this.save({ target, value, status: 'proposed', token: randomUUID(), error: null });
    return { target: light.label, before: light.intensity, proposed: value };
  }
  async read() {
    const [first, second] = this.record.baseline;
    const snap = await this.mcp.call('lighting_inspect_pair', { first: first.id, second: second.id });
    if (
      snap.map !== this.record.map ||
      snap.lights?.length !== 2 ||
      snap.lights[0].id !== first.id ||
      snap.lights[1].id !== second.id
    )
      throw Error('The map or lights changed. Inspect again.');
    return snap.lights;
  }
  receipt(expectedStatus) {
    const { status, observed, error } = this.record;
    if (status !== expectedStatus) throw Error(error || 'The expected change could not be verified.');
    return { status, lights: observed.map(({ label, intensity }) => ({ label, intensity })) };
  }
  async decide(action, token, automatic = false, signal) {
    const r = this.record;
    const undo = action === 'undo';
    if (!r || r.token !== token || r.status !== (undo ? 'applied' : 'proposed'))
      throw Error('This review has expired.');
    const target = r.baseline.find((light) => light.id === r.target);
    const other = r.baseline.find((light) => light.id !== r.target);
    const expected = undo ? r.value : target.intensity;
    const intensity = undo ? target.intensity : r.value;
    const args = {
      first: target.id,
      second: other.id,
      actor_id: target.actor_id,
      expected,
      other_expected: other.intensity,
      intensity,
    };
    this.save({ status: action === 'decline' ? 'checking' : 'applying', error: null });
    try {
      if (action !== 'decline') {
        const before = await this.read();
        if (!before.every((l) => l.intensity === (l.id === target.id ? expected : other.intensity)))
          throw Error('One of the two intensities changed since inspection. Inspect again.');
        signal?.throwIfAborted();
        let result = await this.mcp.call('lighting_set_intensity_checked', args);
        if (result.status === 'plan_mode_required') {
          if (automatic) throw Error('Unreal Plan Mode requires review. For zero approvals, turn it off in Hayba Settings → Preferences → External MCP safety in this project, then inspect again.');
          this.save({ status: 'editor-review' });
          const deadline = Date.now() + 300000;
          for (;;) {
            await delay(650, undefined, { signal: this.controller.signal });
            const check = await this.mcp.call('lighting_review_status', { proposal_id: result.proposal_id });
            if (check.status === 'approved') break;
            if (check.status !== 'pending' || Date.now() > deadline)
              throw Error('Unreal closed or declined the review. Inspect again before retrying.');
          }
          this.save({ status: 'applying' });
          result = await this.mcp.call('lighting_set_intensity_checked', args);
          if (result.status === 'plan_mode_required') throw Error('The reviewed target changed. Inspect again.');
        }
      }
      // Always perform a separate read from Unreal, including after a decline.
      const observed = await this.read();
      const wanted = action === 'decline' ? expected : intensity;
      const verified = observed.every(
        (light) => light.intensity === (light.id === target.id ? wanted : other.intensity),
      );
      if (!verified) {
        this.save({
          observed,
          status: 'unverified',
          error: 'The editor values differ from the expected pair. Inspect again.',
        });
        return;
      }
      const status = undo ? 'undone' : action === 'decline' ? 'declined' : 'applied';
      this.save({
        status,
        observed,
        token: randomUUID(),
        history: [
          ...(r.history || []),
          { status, target: target.label, requested: intensity, values: observed.map((l) => l.intensity) },
        ],
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      // A lost reply can follow a successful mutation. Never replay an uncertain write.
      let observed;
      try {
        observed = await this.read();
      } catch {}
      this.save({ status: 'unverified', observed: observed || [], error: error.message });
    }
  }
}
module.exports = { LightingSession };

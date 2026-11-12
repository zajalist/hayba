import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const audio = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPAudioHandler.cpp'),
  'utf8',
).replace(/\r\n/g, '\n');

// During PIE the UI lane's hover/confirm sounds play on the PIE world's audio device;
// reading GEngine's main device listed nothing.
describe('audio_active_sounds reads the device of the world that is playing', () => {
  const body = audio.slice(audio.indexOf('FHaybaHandlerResult ActiveSounds('), audio.indexOf('FHaybaHandlerResult MeterStart('));

  it('resolves auto / pie / editor to a world and reads that world audio device', () => {
    expect(body).toContain('if (WorldChoice == TEXT("auto")) World = ActiveAudioWorld();');
    expect(body).toContain('World->GetAudioDevice()');
    expect(body).not.toContain('GetMainAudioDevice()');
  });

  it('says which world it read', () => {
    expect(body).toContain('Out->SetStringField(TEXT("world"), WorldKind(World));');
  });
});

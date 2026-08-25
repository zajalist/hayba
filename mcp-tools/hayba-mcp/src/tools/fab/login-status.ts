import { z } from 'zod';
import { fabUnavailable } from './unimplemented.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking whether the user is currently logged into Fab through the editor',
  not_when: 'you already know the user is logged in (or about to call any fab_* tool — they will return a clear not_logged_in error)',
};

export const schema = z.object({});
export type FabLoginStatusParams = z.infer<typeof schema>;

export async function handleFabLoginStatus(_params: FabLoginStatusParams) {
  return fabUnavailable('fab_login_status');
}

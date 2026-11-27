import type { EffortLevel } from '../../protocol.ts';
import type { Bot } from '../repository.ts';

type Profile = { name: string; role: string; instructions: string; color?: unknown; avatar?: unknown;
  model?: string; effort?: EffortLevel; workDir?: string; sectionId?: unknown };

export function rosterCopy(ports: {
  liveBot: (id: string) => (Profile & { id: string; private: boolean }) | undefined;
  botNameTaken: (name: string) => boolean;
  rt: { catalog: () => Promise<{ ref: string }[]>; isFolder: (folder: string) => Promise<boolean> };
  createBot: (profile: Omit<Profile, 'effort'> & { effort?: EffortLevel | null; copyOf: string }) => Bot;
}): (id: string) => Promise<Bot>;

export function copyAppearance(profile: Pick<Profile, 'color' | 'avatar' | 'sectionId'>): Pick<Profile, 'color' | 'avatar' | 'sectionId'>;
export const MAX_AVATAR_IMAGE: number;

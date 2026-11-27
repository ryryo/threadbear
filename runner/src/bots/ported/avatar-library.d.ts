export type AvatarPhoto = { id: string; name: string; mime: string; bytes: number; createdAt: number };
export type AvatarImport = { name: string; image: string };
export type AvatarPage = { items: (AvatarPhoto & { image: string })[]; total: number; next: number };
export type AvatarReport = { imported: AvatarPhoto[]; duplicates: Pick<AvatarPhoto, 'id' | 'name'>[]; failed: { name: string; message: string }[] };
export type AvatarLibrary = {
  avatarLibraryView(input?: { offset?: number; limit?: number }, authorize?: () => void): Promise<AvatarPage>;
  avatarLibraryImport(items: AvatarImport[], authorize?: () => void): Promise<AvatarReport>;
  avatarLibraryDelete(id: string, authorize?: () => void): Promise<boolean>;
};
export function install(rt: { home: string }): AvatarLibrary;

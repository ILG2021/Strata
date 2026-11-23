import type { NativeState } from './native';

/**
 * Can the model that answers this chat take a picture, and if not, what does the person do next?
 *
 * One answer for the composer (the "+" button, paste and drop) and for Send, so they always agree. Pictures are on by default for every
 * model that can read them (owner rule); this says "no" only when the model cannot, or when it was loaded or set with pictures off.
 * A local model: it was loaded with picture reading (`vision`); the catalog says whether this model could (and the engine has the reader).
 */
export type PictureStatus =
  | { ok: true }
  | { ok: false; why: 'none' | 'local-off' | 'local-cannot'; message: string; openModels: boolean };

export function pictureStatus(native: NativeState | null): PictureStatus {
  const instance = native?.instances.find(i => i.id === native.defaultId && i.status === 'ready');
  if (!instance) return { ok: false, why: 'none', openModels: true, message: 'Load a model that reads pictures first, then add the picture.' };
  if (instance.vision) return { ok: true };
  const size = native?.catalog?.families.flatMap(f => f.sizes.map(s => ({ ...s, images: f.images }))).find(s => s.id === instance.model);
  if (size?.images) return { ok: false, why: 'local-off', openModels: true, message: 'This model was started without picture reading. Open Models, turn on Read pictures and load it again.' };
  return { ok: false, why: 'local-cannot', openModels: false, message: 'This model cannot read pictures. Choose a model that reads pictures, or remove the picture.' };
}

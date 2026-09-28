// Per-document context shared by node views and menus (set when a tab is shown).
export const editorCtx = {
  docDir: null as string | null,
  docPath: null as string | null,
  /** open a link target (url, relative file or #anchor) */
  openLink: (_href: string) => {},
  /** pick image files and insert them */
  pickImages: async () => {},
  /** store pasted/dropped image data, returns markdown src */
  storeImage: async (_data: ArrayBuffer, _mime: string, _name?: string): Promise<string | null> => null,
}

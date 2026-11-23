/** A model to chat with: the older runtime's loaded model, or a ready instance of the native engine. */
export function hasModelToChat(input: { localLoaded: unknown; nativeReady: boolean }): boolean {
  return !!input.localLoaded || input.nativeReady;
}

/** The plain line under the message box when text is typed and there is no model to chat with. */
export function showNoModelHint(input: { streaming: boolean; canChat: boolean; hasText: boolean; hasPhotos: boolean; bareSlash: boolean }): boolean {
  return !input.streaming && !input.canChat && (input.hasText || input.hasPhotos) && !input.bareSlash;
}

declare global {
  interface Window {
    api: {
      openFile(): Promise<{ filePath: string; content: string } | null>
      saveFile(filePath: string, content: string): Promise<string | null>
      saveFileAs(content: string): Promise<string | null>
      loadFromCompanion(): Promise<{ filePath: string; content: string; isLiveDb: boolean; version: number } | { error: string }>
      saveToCompanion(content: string): Promise<{ ok: boolean } | { error: string } | { cancelled: boolean } | null>
      getActionLibrary(): Promise<{ actions: Array<{ connectionId: string; definitionId: string; options: Record<string, unknown> }> } | { error: string }>
      onCompanionChange(cb: (data: { filePath: string; content: string }) => void): () => void
    }
  }
}

export {}

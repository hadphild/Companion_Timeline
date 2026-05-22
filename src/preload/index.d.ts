declare global {
  interface Window {
    api: {
      openFile(): Promise<{ filePath: string; content: string } | null>
      saveFile(filePath: string, content: string): Promise<string | null>
      saveFileAs(content: string): Promise<string | null>
      loadFromCompanion(): Promise<{ filePath: string; content: string; isLiveDb: boolean; version: number; isRemote?: boolean; remoteHost?: string } | { error: string }>
      saveToCompanion(content: string): Promise<{ ok: boolean } | { error: string } | { cancelled: boolean } | null>
      getActionLibrary(): Promise<{ actions: Array<{ connectionId: string; definitionId: string; options: Record<string, unknown> }> } | { error: string }>
      onCompanionChange(cb: (data: { filePath: string; content: string }) => void): () => void
      saveSilent(content: string): Promise<{ ok: boolean } | { error: string }>
      pausePolling(): Promise<void>
      resumePolling(): Promise<void>
      getSettings(): Promise<Record<string, unknown>>
      setSettings(patch: Record<string, unknown>): Promise<boolean>
    }
  }
}

export {}

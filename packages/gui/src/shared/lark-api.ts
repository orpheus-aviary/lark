/** The preload bridge surface. Shared by preload (producer) and renderer (consumer). */
export interface LarkApi {
  /**
   * Daemon base URL, injected by main through `additionalArguments`. `null`
   * when main did not pass one — the renderer then falls back to the default
   * loopback port.
   */
  readonly daemonUrl: string | null;
}

export const shouldShowBaremetalBanner = (
  platform: string | undefined,
  loaded: boolean,
  cvmPeerPods: boolean,
): boolean =>
  loaded && Boolean(platform) && platform !== 'BareMetal' && platform !== 'None' && !cvmPeerPods;

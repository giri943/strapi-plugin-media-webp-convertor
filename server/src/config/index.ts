export default {
  default: {
    webpQuality: 82,
    webpConversionEnabled: true,
  },
  validator(config: { webpQuality?: number; webpConversionEnabled?: boolean }) {
    if (config.webpQuality !== undefined) {
      const q = Number(config.webpQuality);
      if (Number.isNaN(q) || q < 1 || q > 100) {
        throw new Error('plugin config webpQuality must be between 1 and 100');
      }
    }
  },
};

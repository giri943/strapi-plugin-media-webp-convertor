export default {
  default: {
    webpQuality: 82,
    webpConversionEnabled: true,
    pdfValidationEnabled: true,
    maxPdfSizeMb: 25,
    blockPdfActiveContent: true,
  },
  validator(config: {
    webpQuality?: number;
    webpConversionEnabled?: boolean;
    pdfValidationEnabled?: boolean;
    maxPdfSizeMb?: number;
    blockPdfActiveContent?: boolean;
  }) {
    if (config.webpQuality !== undefined) {
      const q = Number(config.webpQuality);
      if (Number.isNaN(q) || q < 1 || q > 100) {
        throw new Error('plugin config webpQuality must be between 1 and 100');
      }
    }
    if (config.maxPdfSizeMb !== undefined) {
      const mb = Number(config.maxPdfSizeMb);
      if (Number.isNaN(mb) || mb < 1 || mb > 500) {
        throw new Error('plugin config maxPdfSizeMb must be between 1 and 500');
      }
    }
  },
};

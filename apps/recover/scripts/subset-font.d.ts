declare module 'subset-font' {
  interface SubsetOptions {
    readonly targetFormat?: 'woff2' | 'woff' | 'sfnt' | 'truetype';
    readonly variationAxes?: Readonly<Record<string, number>>;
    readonly keepFeatures?: readonly string[];
    readonly noHinting?: boolean;
  }
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: SubsetOptions,
  ): Promise<Buffer>;
}

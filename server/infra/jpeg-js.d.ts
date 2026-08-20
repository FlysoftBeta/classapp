declare module "jpeg-js" {
  interface JpegImage {
    width: number;
    height: number;
    data: Uint8Array;
  }
  export function decode(
    data: Uint8Array | Buffer,
    opts?: { useTArray?: boolean; maxResolutionInMP?: number },
  ): JpegImage;
  export function encode(
    image: { data: Uint8Array | Buffer; width: number; height: number },
    quality?: number,
  ): { data: Uint8Array; width: number; height: number };
  const jpegJs: { decode: typeof decode; encode: typeof encode };
  export default jpegJs;
}

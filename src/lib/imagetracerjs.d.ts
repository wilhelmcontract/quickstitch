declare module "imagetracerjs" {
  type Palette = { r: number; g: number; b: number; a: number };
  type QuantResult = { array: number[][]; palette: Palette[] };

  const ImageTracer: {
    colorquantization: (
      imgd: { data: Uint8ClampedArray; width: number; height: number },
      options: {
        numberofcolors?: number;
        colorsampling?: 0 | 1 | 2;
        colorquantcycles?: number;
        mincolorratio?: number;
        blurradius?: number;
        blurdelta?: number;
      },
    ) => QuantResult;
  };

  export default ImageTracer;
}

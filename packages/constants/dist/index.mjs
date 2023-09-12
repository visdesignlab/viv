import GL from '@luma.gl/constants';

const MAX_COLOR_INTENSITY = 255;
const DEFAULT_COLOR_OFF = [0, 0, 0];
const MAX_CHANNELS = 6;
const DEFAULT_FONT_FAMILY = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
const DTYPE_VALUES = {
  Uint8: {
    format: GL.R8UI,
    dataFormat: GL.RED_INTEGER,
    type: GL.UNSIGNED_BYTE,
    max: 2 ** 8 - 1,
    sampler: "usampler2D"
  },
  Uint16: {
    format: GL.R16UI,
    dataFormat: GL.RED_INTEGER,
    type: GL.UNSIGNED_SHORT,
    max: 2 ** 16 - 1,
    sampler: "usampler2D"
  },
  Uint32: {
    format: GL.R32UI,
    dataFormat: GL.RED_INTEGER,
    type: GL.UNSIGNED_INT,
    max: 2 ** 32 - 1,
    sampler: "usampler2D"
  },
  Float32: {
    format: GL.R32F,
    dataFormat: GL.RED,
    type: GL.FLOAT,
    max: 3.4 * 10 ** 38,
    sampler: "sampler2D"
  },
  Int8: {
    format: GL.R8I,
    dataFormat: GL.RED_INTEGER,
    type: GL.BYTE,
    max: 2 ** (8 - 1) - 1,
    sampler: "isampler2D"
  },
  Int16: {
    format: GL.R16I,
    dataFormat: GL.RED_INTEGER,
    type: GL.SHORT,
    max: 2 ** (16 - 1) - 1,
    sampler: "isampler2D"
  },
  Int32: {
    format: GL.R32I,
    dataFormat: GL.RED_INTEGER,
    type: GL.INT,
    max: 2 ** (32 - 1) - 1,
    sampler: "isampler2D"
  },
  Float64: {
    format: GL.R32F,
    dataFormat: GL.RED,
    type: GL.FLOAT,
    max: 3.4 * 10 ** 38,
    sampler: "sampler2D",
    cast: (data) => new Float32Array(data)
  }
};
const COLORMAPS = [
  "jet",
  "hsv",
  "hot",
  "cool",
  "spring",
  "summer",
  "autumn",
  "winter",
  "bone",
  "copper",
  "greys",
  "yignbu",
  "greens",
  "yiorrd",
  "bluered",
  "rdbu",
  "picnic",
  "rainbow",
  "portland",
  "blackbody",
  "earth",
  "electric",
  "alpha",
  "viridis",
  "inferno",
  "magma",
  "plasma",
  "warm",
  "rainbow-soft",
  "bathymetry",
  "cdom",
  "chlorophyll",
  "density",
  "freesurface-blue",
  "freesurface-red",
  "oxygen",
  "par",
  "phase",
  "salinity",
  "temperature",
  "turbidity",
  "velocity-blue",
  "velocity-green",
  "cubehelix"
];
var RENDERING_MODES = /* @__PURE__ */ ((RENDERING_MODES2) => {
  RENDERING_MODES2["MAX_INTENSITY_PROJECTION"] = "Maximum Intensity Projection";
  RENDERING_MODES2["MIN_INTENSITY_PROJECTION"] = "Minimum Intensity Projection";
  RENDERING_MODES2["ADDITIVE"] = "Additive";
  return RENDERING_MODES2;
})(RENDERING_MODES || {});

export { COLORMAPS, DEFAULT_COLOR_OFF, DEFAULT_FONT_FAMILY, DTYPE_VALUES, MAX_CHANNELS, MAX_COLOR_INTENSITY, RENDERING_MODES };

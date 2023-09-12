import { OrthographicView, COORDINATE_SYSTEM, Layer, project32, picking, CompositeLayer } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import GL from '@luma.gl/constants';
import { TileLayer } from '@deck.gl/geo-layers';
import { getImageSize, isInterleaved, SIGNAL_ABORTED } from '@vivjs/loaders';
import { isWebGL2, Model, Geometry, Texture2D, Texture3D } from '@luma.gl/core';
import { ProgramManager } from '@luma.gl/engine';
import { MAX_CHANNELS, DTYPE_VALUES, DEFAULT_FONT_FAMILY } from '@vivjs/constants';
import { hasFeature, FEATURES } from '@luma.gl/webgl';
import { BitmapLayer as BitmapLayer$1, PolygonLayer, LineLayer, TextLayer } from '@deck.gl/layers';
import { ColorPaletteExtension, ColorPalette3DExtensions } from '@vivjs/extensions';
import { Plane } from '@math.gl/culling';

const fs$2 = `float apply_contrast_limits(float intensity, vec2 contrastLimits) {
    return  max(0., (intensity - contrastLimits[0]) / max(0.0005, (contrastLimits[1] - contrastLimits[0])));
}
`;
const channels = {
  name: "channel-intensity",
  defines: {
    SAMPLER_TYPE: "usampler2D",
    COLORMAP_FUNCTION: ""
  },
  fs: fs$2
};

function range(len) {
  return [...Array(len).keys()];
}
function padWithDefault(arr, defaultValue, padWidth) {
  for (let i = 0; i < padWidth; i += 1) {
    arr.push(defaultValue);
  }
  return arr;
}
function getDtypeValues(dtype) {
  const values = DTYPE_VALUES[dtype];
  if (!values) {
    const valid = Object.keys(DTYPE_VALUES);
    throw Error(`Dtype not supported, got ${dtype}. Must be one of ${valid}.`);
  }
  return values;
}
function padContrastLimits({
  contrastLimits = [],
  channelsVisible,
  domain,
  dtype
}) {
  const maxSliderValue = domain && domain[1] || getDtypeValues(dtype).max;
  const newContrastLimits = contrastLimits.map(
    (slider, i) => channelsVisible[i] ? slider : [maxSliderValue, maxSliderValue]
  );
  const padSize = MAX_CHANNELS - newContrastLimits.length;
  if (padSize < 0) {
    throw Error(
      `${newContrastLimits.lengths} channels passed in, but only 6 are allowed.`
    );
  }
  const paddedContrastLimits = padWithDefault(
    newContrastLimits,
    [maxSliderValue, maxSliderValue],
    padSize
  ).reduce((acc, val) => acc.concat(val), []);
  return paddedContrastLimits;
}
function getPhysicalSizeScalingMatrix(loader) {
  const { x, y, z } = loader?.meta?.physicalSizes ?? {};
  if (x?.size && y?.size && z?.size) {
    const min = Math.min(z.size, x.size, y.size);
    const ratio = [x.size / min, y.size / min, z.size / min];
    return new Matrix4().scale(ratio);
  }
  return new Matrix4().identity();
}
function makeBoundingBox(viewState) {
  const viewport = new OrthographicView().makeViewport({
    viewState,
    height: viewState.height,
    width: viewState.width
  });
  return [
    viewport.unproject([0, 0]),
    viewport.unproject([viewport.width, 0]),
    viewport.unproject([viewport.width, viewport.height]),
    viewport.unproject([0, viewport.height])
  ];
}

const fs$1 = `#define SHADER_NAME xr-layer-fragment-shader

precision highp float;
precision highp int;
precision highp SAMPLER_TYPE;

// our texture
uniform SAMPLER_TYPE channel0;
uniform SAMPLER_TYPE channel1;
uniform SAMPLER_TYPE channel2;
uniform SAMPLER_TYPE channel3;
uniform SAMPLER_TYPE channel4;
uniform SAMPLER_TYPE channel5;

in vec2 vTexCoord;

// range
uniform vec2 contrastLimits[6];

void main() {

  float intensity0 = float(texture(channel0, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity0, contrastLimits[0], 0);
  float intensity1 = float(texture(channel1, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity1, contrastLimits[1], 1);
  float intensity2 = float(texture(channel2, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity2, contrastLimits[2], 2);
  float intensity3 = float(texture(channel3, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity3, contrastLimits[3], 3);
  float intensity4 = float(texture(channel4, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity4, contrastLimits[4], 4);
  float intensity5 = float(texture(channel5, vTexCoord).r);
  DECKGL_PROCESS_INTENSITY(intensity5, contrastLimits[5], 5);

  DECKGL_MUTATE_COLOR(gl_FragColor, intensity0, intensity1, intensity2, intensity3, intensity4, intensity5, vTexCoord);


  geometry.uv = vTexCoord;
  DECKGL_FILTER_COLOR(gl_FragColor, geometry);
}
`;

const vs$1 = `#define SHADER_NAME xr-layer-vertex-shader

attribute vec2 texCoords;
attribute vec3 positions;
attribute vec3 positions64Low;
attribute vec3 instancePickingColors;
varying vec2 vTexCoord;

void main(void) {
  geometry.worldPosition = positions;
  geometry.uv = texCoords;
  geometry.pickingColor = instancePickingColors;
  gl_Position = project_position_to_clipspace(positions, positions64Low, vec3(0.), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vTexCoord = texCoords;
  vec4 color = vec4(0.);
  DECKGL_FILTER_COLOR(color, geometry);
}
`;

const coreShaderModule = { fs: fs$1, vs: vs$1 };
function validateWebGL2Filter(gl, interpolation) {
  const canShowFloat = hasFeature(gl, FEATURES.TEXTURE_FLOAT);
  const canShowLinear = hasFeature(gl, FEATURES.TEXTURE_FILTER_LINEAR_FLOAT);
  if (!canShowFloat) {
    throw new Error(
      "WebGL1 context does not support floating point textures.  Unable to display raster data."
    );
  }
  if (!canShowLinear && interpolation === GL.LINEAR) {
    console.warn(
      "LINEAR filtering not supported in WebGL1 context.  Falling back to NEAREST."
    );
    return GL.NEAREST;
  }
  return interpolation;
}
function getRenderingAttrs$1(dtype, gl, interpolation) {
  if (!isWebGL2(gl)) {
    return {
      format: GL.LUMINANCE,
      dataFormat: GL.LUMINANCE,
      type: GL.FLOAT,
      sampler: "sampler2D",
      shaderModule: coreShaderModule,
      filter: validateWebGL2Filter(gl, interpolation),
      cast: (data) => new Float32Array(data)
    };
  }
  const isLinear = interpolation === GL.LINEAR;
  const upgradedShaderModule = { ...coreShaderModule };
  const version300str = "#version 300 es\n";
  upgradedShaderModule.fs = version300str.concat(upgradedShaderModule.fs);
  upgradedShaderModule.vs = version300str.concat(upgradedShaderModule.vs);
  const values = getDtypeValues(isLinear ? "Float32" : dtype);
  return {
    shaderModule: upgradedShaderModule,
    filter: interpolation,
    cast: isLinear ? (data) => new Float32Array(data) : (data) => data,
    ...values
  };
}

const defaultProps$8 = {
  pickable: { type: "boolean", value: true, compare: true },
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  channelData: { type: "object", value: {}, compare: true },
  bounds: { type: "array", value: [0, 0, 1, 1], compare: true },
  contrastLimits: { type: "array", value: [], compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  dtype: { type: "string", value: "Uint16", compare: true },
  interpolation: {
    type: "number",
    value: GL.NEAREST,
    compare: true
  }
};
const XRLayer = class extends Layer {
  getShaders() {
    const { dtype, interpolation } = this.props;
    const { shaderModule, sampler } = getRenderingAttrs$1(
      dtype,
      this.context.gl,
      interpolation
    );
    const extensionDefinesDeckglProcessIntensity = this._isHookDefinedByExtensions("fs:DECKGL_PROCESS_INTENSITY");
    const newChannelsModule = { ...channels, inject: {} };
    if (!extensionDefinesDeckglProcessIntensity) {
      newChannelsModule.inject["fs:DECKGL_PROCESS_INTENSITY"] = `
        intensity = apply_contrast_limits(intensity, contrastLimits);
      `;
    }
    return super.getShaders({
      ...shaderModule,
      defines: {
        SAMPLER_TYPE: sampler
      },
      modules: [project32, picking, newChannelsModule]
    });
  }
  _isHookDefinedByExtensions(hookName) {
    const { extensions } = this.props;
    return extensions?.some((e) => {
      const shaders = e.getShaders();
      const { inject = {}, modules = [] } = shaders;
      const definesInjection = inject[hookName];
      const moduleDefinesInjection = modules.some((m) => m?.inject[hookName]);
      return definesInjection || moduleDefinesInjection;
    });
  }
  initializeState() {
    const { gl } = this.context;
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.PACK_ALIGNMENT, 1);
    const attributeManager = this.getAttributeManager();
    attributeManager.add({
      positions: {
        size: 3,
        type: GL.DOUBLE,
        fp64: this.use64bitPositions(),
        update: this.calculatePositions,
        noAlloc: true
      }
    });
    this.setState({
      numInstances: 1,
      positions: new Float64Array(12)
    });
    const programManager = ProgramManager.getDefaultProgramManager(gl);
    const mutateStr = "fs:DECKGL_MUTATE_COLOR(inout vec4 rgba, float intensity0, float intensity1, float intensity2, float intensity3, float intensity4, float intensity5, vec2 vTexCoord)";
    const processStr = `fs:DECKGL_PROCESS_INTENSITY(inout float intensity, vec2 contrastLimits, int channelIndex)`;
    if (!programManager._hookFunctions.includes(mutateStr)) {
      programManager.addShaderHook(mutateStr);
    }
    if (!programManager._hookFunctions.includes(processStr)) {
      programManager.addShaderHook(processStr);
    }
  }
  finalizeState() {
    super.finalizeState();
    if (this.state.textures) {
      Object.values(this.state.textures).forEach((tex) => tex && tex.delete());
    }
  }
  updateState({ props, oldProps, changeFlags, ...rest }) {
    super.updateState({ props, oldProps, changeFlags, ...rest });
    if (changeFlags.extensionsChanged || props.interpolation !== oldProps.interpolation) {
      const { gl } = this.context;
      if (this.state.model) {
        this.state.model.delete();
      }
      this.setState({ model: this._getModel(gl) });
      this.getAttributeManager().invalidateAll();
    }
    if (props.channelData !== oldProps.channelData && props.channelData?.data !== oldProps.channelData?.data || props.interpolation !== oldProps.interpolation) {
      this.loadChannelTextures(props.channelData);
    }
    const attributeManager = this.getAttributeManager();
    if (props.bounds !== oldProps.bounds) {
      attributeManager.invalidate("positions");
    }
  }
  _getModel(gl) {
    if (!gl) {
      return null;
    }
    return new Model(gl, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: new Geometry({
        drawMode: GL.TRIANGLE_FAN,
        vertexCount: 4,
        attributes: {
          texCoords: new Float32Array([0, 1, 0, 0, 1, 0, 1, 1])
        }
      }),
      isInstanced: false
    });
  }
  calculatePositions(attributes) {
    const { positions } = this.state;
    const { bounds } = this.props;
    positions[0] = bounds[0];
    positions[1] = bounds[1];
    positions[2] = 0;
    positions[3] = bounds[0];
    positions[4] = bounds[3];
    positions[5] = 0;
    positions[6] = bounds[2];
    positions[7] = bounds[3];
    positions[8] = 0;
    positions[9] = bounds[2];
    positions[10] = bounds[1];
    positions[11] = 0;
    attributes.value = positions;
  }
  draw({ uniforms }) {
    const { textures, model } = this.state;
    if (textures && model) {
      const { contrastLimits, domain, dtype, channelsVisible } = this.props;
      const numTextures = Object.values(textures).filter((t) => t).length;
      const paddedContrastLimits = padContrastLimits({
        contrastLimits: contrastLimits.slice(0, numTextures),
        channelsVisible: channelsVisible.slice(0, numTextures),
        domain,
        dtype
      });
      model.setUniforms({
        ...uniforms,
        contrastLimits: paddedContrastLimits,
        ...textures
      }).draw();
    }
  }
  loadChannelTextures(channelData) {
    const textures = {
      channel0: null,
      channel1: null,
      channel2: null,
      channel3: null,
      channel4: null,
      channel5: null
    };
    if (this.state.textures) {
      Object.values(this.state.textures).forEach((tex) => tex && tex.delete());
    }
    if (channelData && Object.keys(channelData).length > 0 && channelData.data) {
      channelData.data.forEach((d, i) => {
        textures[`channel${i}`] = this.dataToTexture(
          d,
          channelData.width,
          channelData.height
        );
      }, this);
      this.setState({ textures });
    }
  }
  dataToTexture(data, width, height) {
    const { interpolation } = this.props;
    const attrs = getRenderingAttrs$1(
      this.props.dtype,
      this.context.gl,
      interpolation
    );
    return new Texture2D(this.context.gl, {
      width,
      height,
      data: attrs.cast?.(data) ?? data,
      mipmaps: false,
      parameters: {
        [GL.TEXTURE_MIN_FILTER]: attrs.filter,
        [GL.TEXTURE_MAG_FILTER]: attrs.filter,
        [GL.TEXTURE_WRAP_S]: GL.CLAMP_TO_EDGE,
        [GL.TEXTURE_WRAP_T]: GL.CLAMP_TO_EDGE
      },
      format: attrs.format,
      dataFormat: attrs.dataFormat,
      type: attrs.type
    });
  }
};
XRLayer.layerName = "XRLayer";
XRLayer.defaultProps = defaultProps$8;

const PHOTOMETRIC_INTERPRETATIONS = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  RGB: 2,
  Palette: 3,
  TransparencyMask: 4,
  CMYK: 5,
  YCbCr: 6,
  CIELab: 8,
  ICCLab: 9
};
const defaultProps$7 = {
  ...BitmapLayer$1.defaultProps,
  pickable: { type: "boolean", value: true, compare: true },
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN
};
const getPhotometricInterpretationShader = (photometricInterpretation, transparentColorInHook) => {
  const useTransparentColor = transparentColorInHook ? "true" : "false";
  const transparentColorVector = `vec3(${(transparentColorInHook || [0, 0, 0]).map((i) => String(i / 255)).join(",")})`;
  switch (photometricInterpretation) {
    case PHOTOMETRIC_INTERPRETATIONS.RGB:
      return `color[3] = (${useTransparentColor} && (color.rgb == ${transparentColorVector})) ? 0.0 : color.a;`;
    case PHOTOMETRIC_INTERPRETATIONS.WhiteIsZero:
      return `          float value = 1.0 - (color.r / 256.0);
          color = vec4(value, value, value, (${useTransparentColor} && vec3(value, value, value) == ${transparentColorVector}) ? 0.0 : color.a);
        `;
    case PHOTOMETRIC_INTERPRETATIONS.BlackIsZero:
      return `          float value = (color.r / 256.0);
          color = vec4(value, value, value, (${useTransparentColor} && vec3(value, value, value) == ${transparentColorVector}) ? 0.0 : color.a);
        `;
    case PHOTOMETRIC_INTERPRETATIONS.YCbCr:
      return `          float y = color[0];
          float cb = color[1];
          float cr = color[2];
          color[0] = (y + (1.40200 * (cr - .5)));
          color[1] = (y - (0.34414 * (cb - .5)) - (0.71414 * (cr - .5)));
          color[2] = (y + (1.77200 * (cb - .5)));
          color[3] = (${useTransparentColor} && distance(color.rgb, ${transparentColorVector}) < 0.01) ? 0.0 : color.a;
        `;
    default:
      console.error(
        "Unsupported photometric interpretation or none provided.  No transformation will be done to image data"
      );
      return "";
  }
};
const getTransparentColor = (photometricInterpretation) => {
  switch (photometricInterpretation) {
    case PHOTOMETRIC_INTERPRETATIONS.RGB:
      return [0, 0, 0, 0];
    case PHOTOMETRIC_INTERPRETATIONS.WhiteIsZero:
      return [255, 255, 255, 0];
    case PHOTOMETRIC_INTERPRETATIONS.BlackIsZero:
      return [0, 0, 0, 0];
    case PHOTOMETRIC_INTERPRETATIONS.YCbCr:
      return [16, 128, 128, 0];
    default:
      console.error(
        "Unsupported photometric interpretation or none provided.  No transformation will be done to image data"
      );
      return [0, 0, 0, 0];
  }
};
class BitmapLayerWrapper extends BitmapLayer$1 {
  _getModel(gl) {
    const { photometricInterpretation, transparentColorInHook } = this.props;
    const photometricInterpretationShader = getPhotometricInterpretationShader(
      photometricInterpretation,
      transparentColorInHook
    );
    if (!gl) {
      return null;
    }
    return new Model(gl, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: new Geometry({
        drawMode: GL.TRIANGLES,
        vertexCount: 6
      }),
      isInstanced: false,
      inject: {
        "fs:DECKGL_FILTER_COLOR": photometricInterpretationShader
      }
    });
  }
}
const BitmapLayer = class extends CompositeLayer {
  initializeState(args) {
    const { gl } = this.context;
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.PACK_ALIGNMENT, 1);
    super.initializeState(args);
  }
  renderLayers() {
    const {
      photometricInterpretation,
      transparentColor: transparentColorInHook
    } = this.props;
    const transparentColor = getTransparentColor(photometricInterpretation);
    return new BitmapLayerWrapper(this.props, {
      transparentColor,
      transparentColorInHook,
      id: `${this.props.id}-wrapped`
    });
  }
};
BitmapLayer.layerName = "BitmapLayer";
BitmapLayer.PHOTOMETRIC_INTERPRETATIONS = PHOTOMETRIC_INTERPRETATIONS;
BitmapLayer.defaultProps = {
  ...defaultProps$7,
  image: { type: "object", value: {}, compare: true },
  transparentColor: { type: "array", value: [0, 0, 0], compare: true },
  photometricInterpretation: { type: "number", value: 2, compare: true }
};
BitmapLayerWrapper.defaultProps = defaultProps$7;
BitmapLayerWrapper.layerName = "BitmapLayerWrapper";

function renderSubLayers(props) {
  const {
    bbox: { left, top, right, bottom },
    index: { x, y, z }
  } = props.tile;
  const { data, id, loader, maxZoom } = props;
  if ([left, bottom, right, top].some((v) => v < 0) || !data) {
    return null;
  }
  const base = loader[0];
  const { height, width } = getImageSize(base);
  const bounds = [
    left,
    data.height < base.tileSize ? height : bottom,
    data.width < base.tileSize ? width : right,
    top
  ];
  if (isInterleaved(base.shape)) {
    const { photometricInterpretation = 2 } = base.meta;
    return new BitmapLayer(props, {
      image: data,
      photometricInterpretation,
      bounds,
      id: `tile-sub-layer-${bounds}-${id}`,
      tileId: { x, y, z },
      extensions: []
    });
  }
  return new XRLayer(props, {
    channelData: data,
    bounds,
    id: `tile-sub-layer-${bounds}-${id}`,
    tileId: { x, y, z },
    interpolation: z === maxZoom ? GL.NEAREST : GL.LINEAR
  });
}

const defaultProps$6 = {
  pickable: { type: "boolean", value: true, compare: true },
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  contrastLimits: { type: "array", value: [], compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  renderSubLayers: { type: "function", value: renderSubLayers, compare: false },
  dtype: { type: "string", value: "Uint16", compare: true },
  domain: { type: "array", value: [], compare: true },
  viewportId: { type: "string", value: "", compare: true },
  interpolation: { type: "number", value: null, compare: true }
};
class MultiscaleImageLayerBase extends TileLayer {
  _updateTileset() {
    if (!this.props.viewportId) {
      super._updateTileset();
    }
    if (this.props.viewportId && this.context.viewport.id === this.props.viewportId || !this.state.tileset._viewport) {
      super._updateTileset();
    }
  }
}
MultiscaleImageLayerBase.layerName = "MultiscaleImageLayerBase";
MultiscaleImageLayerBase.defaultProps = defaultProps$6;

const defaultProps$5 = {
  pickable: { type: "boolean", value: true, compare: true },
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  contrastLimits: { type: "array", value: [], compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  selections: { type: "array", value: [], compare: true },
  domain: { type: "array", value: [], compare: true },
  viewportId: { type: "string", value: "", compare: true },
  loader: {
    type: "object",
    value: {
      getRaster: async () => ({ data: [], height: 0, width: 0 }),
      dtype: "Uint16",
      shape: []
    },
    compare: true
  },
  onClick: { type: "function", value: null, compare: true },
  onViewportLoad: { type: "function", value: null, compare: true },
  interpolation: {
    type: "number",
    value: GL.NEAREST,
    compare: true
  },
  extensions: {
    type: "array",
    value: [new ColorPaletteExtension()],
    compare: true
  }
};
const ImageLayer = class extends CompositeLayer {
  finalizeState() {
    this.state.abortController.abort();
  }
  updateState({ props, oldProps }) {
    const loaderChanged = props.loader !== oldProps.loader;
    const selectionsChanged = props.selections !== oldProps.selections;
    if (loaderChanged || selectionsChanged) {
      const { loader, selections = [], onViewportLoad } = this.props;
      const abortController = new AbortController();
      this.setState({ abortController });
      const { signal } = abortController;
      const getRaster = (selection) => loader.getRaster({ selection, signal });
      const dataPromises = selections.map(getRaster);
      Promise.all(dataPromises).then((rasters) => {
        const raster = {
          data: rasters.map((d) => d.data),
          width: rasters[0]?.width,
          height: rasters[0]?.height
        };
        if (isInterleaved(loader.shape)) {
          raster.data = raster.data[0];
          if (raster.data.length === raster.width * raster.height * 3) {
            raster.format = GL.RGB;
            raster.dataFormat = GL.RGB;
          }
        }
        if (onViewportLoad) {
          onViewportLoad(raster);
        }
        this.setState({ ...raster });
      }).catch((e) => {
        if (e !== SIGNAL_ABORTED) {
          throw e;
        }
      });
    }
  }
  getPickingInfo({ info, sourceLayer }) {
    info.sourceLayer = sourceLayer;
    info.tile = sourceLayer.props.tile;
    return info;
  }
  renderLayers() {
    const { loader, id } = this.props;
    const { dtype } = loader;
    const { width, height, data } = this.state;
    if (!(width && height))
      return null;
    const bounds = [0, height, width, 0];
    if (isInterleaved(loader.shape)) {
      const { photometricInterpretation = 2 } = loader.meta;
      return new BitmapLayer(this.props, {
        image: this.state,
        photometricInterpretation,
        bounds,
        id: `image-sub-layer-${bounds}-${id}`,
        extensions: []
      });
    }
    return new XRLayer(this.props, {
      channelData: { data, height, width },
      bounds,
      id: `image-sub-layer-${bounds}-${id}`,
      dtype
    });
  }
};
ImageLayer.layerName = "ImageLayer";
ImageLayer.defaultProps = defaultProps$5;

const defaultProps$4 = {
  pickable: { type: "boolean", value: true, compare: true },
  onHover: { type: "function", value: null, compare: false },
  contrastLimits: { type: "array", value: [], compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  domain: { type: "array", value: [], compare: true },
  viewportId: { type: "string", value: "", compare: true },
  maxRequests: { type: "number", value: 10, compare: true },
  onClick: { type: "function", value: null, compare: true },
  refinementStrategy: { type: "string", value: null, compare: true },
  excludeBackground: { type: "boolean", value: false, compare: true },
  extensions: {
    type: "array",
    value: [new ColorPaletteExtension()],
    compare: true
  }
};
const MultiscaleImageLayer = class extends CompositeLayer {
  renderLayers() {
    const {
      loader,
      selections,
      opacity,
      viewportId,
      onTileError,
      onHover,
      id,
      onClick,
      modelMatrix,
      excludeBackground,
      refinementStrategy
    } = this.props;
    const { tileSize, dtype } = loader[0];
    const getTileData = async ({ index: { x, y, z }, signal }) => {
      if (!selections || selections.length === 0) {
        return null;
      }
      const resolution = Math.round(-z);
      const getTile = (selection) => {
        const config = { x, y, selection, signal };
        return loader[resolution].getTile(config);
      };
      try {
        const tiles = await Promise.all(selections.map(getTile));
        const tile = {
          data: tiles.map((d) => d.data),
          width: tiles[0].width,
          height: tiles[0].height
        };
        if (isInterleaved(loader[resolution].shape)) {
          tile.data = tile.data[0];
          if (tile.data.length === tile.width * tile.height * 3) {
            tile.format = GL.RGB;
            tile.dataFormat = GL.RGB;
          }
          return tile;
        }
        return tile;
      } catch (err) {
        if (err === SIGNAL_ABORTED) {
          return null;
        }
        throw err;
      }
    };
    const { height, width } = getImageSize(loader[0]);
    const tiledLayer = new MultiscaleImageLayerBase(this.props, {
      id: `Tiled-Image-${id}`,
      getTileData,
      dtype,
      tileSize,
      zoomOffset: Math.round(
        Math.log2(modelMatrix ? modelMatrix.getScale()[0] : 1)
      ),
      extent: [0, 0, width, height],
      minZoom: Math.round(-(loader.length - 1)),
      maxZoom: 0,
      refinementStrategy: refinementStrategy || (opacity === 1 ? "best-available" : "no-overlap"),
      updateTriggers: {
        getTileData: [loader, selections]
      },
      onTileError: onTileError || loader[0].onTileError
    });
    const lowestResolution = loader[loader.length - 1];
    const implementsGetRaster = typeof lowestResolution.getRaster === "function";
    const layerModelMatrix = modelMatrix ? modelMatrix.clone() : new Matrix4();
    const baseLayer = implementsGetRaster && !excludeBackground && new ImageLayer(this.props, {
      id: `Background-Image-${id}`,
      loader: lowestResolution,
      modelMatrix: layerModelMatrix.scale(2 ** (loader.length - 1)),
      visible: !viewportId || this.context.viewport.id === viewportId,
      onHover,
      onClick,
      interpolation: GL.LINEAR,
      onViewportLoad: null
    });
    const layers = [baseLayer, tiledLayer];
    return layers;
  }
};
MultiscaleImageLayer.layerName = "MultiscaleImageLayer";
MultiscaleImageLayer.defaultProps = defaultProps$4;

const defaultProps$3 = {
  pickable: { type: "boolean", value: true, compare: true },
  loader: {
    type: "object",
    value: {
      getRaster: async () => ({ data: [], height: 0, width: 0 }),
      getRasterSize: () => ({ height: 0, width: 0 }),
      dtype: "<u2"
    },
    compare: true
  },
  id: { type: "string", value: "", compare: true },
  boundingBox: {
    type: "array",
    value: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0]
    ],
    compare: true
  },
  boundingBoxColor: { type: "array", value: [255, 0, 0], compare: true },
  boundingBoxOutlineWidth: { type: "number", value: 1, compare: true },
  viewportOutlineColor: { type: "array", value: [255, 190, 0], compare: true },
  viewportOutlineWidth: { type: "number", value: 2, compare: true },
  overviewScale: { type: "number", value: 1, compare: true },
  zoom: { type: "number", value: 1, compare: true }
};
const OverviewLayer = class extends CompositeLayer {
  renderLayers() {
    const {
      loader,
      id,
      zoom,
      boundingBox,
      boundingBoxColor,
      boundingBoxOutlineWidth,
      viewportOutlineColor,
      viewportOutlineWidth,
      overviewScale
    } = this.props;
    const { width, height } = getImageSize(loader[0]);
    const z = loader.length - 1;
    const lowestResolution = loader[z];
    const overview = new ImageLayer(this.props, {
      id: `viewport-${id}`,
      modelMatrix: new Matrix4().scale(2 ** z * overviewScale),
      loader: lowestResolution
    });
    const boundingBoxOutline = new PolygonLayer({
      id: `bounding-box-overview-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [boundingBox],
      getPolygon: (f) => f,
      filled: false,
      stroked: true,
      getLineColor: boundingBoxColor,
      getLineWidth: boundingBoxOutlineWidth * 2 ** zoom
    });
    const viewportOutline = new PolygonLayer({
      id: `viewport-outline-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [
        [
          [0, 0],
          [width * overviewScale, 0],
          [width * overviewScale, height * overviewScale],
          [0, height * overviewScale]
        ]
      ],
      getPolygon: (f) => f,
      filled: false,
      stroked: true,
      getLineColor: viewportOutlineColor,
      getLineWidth: viewportOutlineWidth * 2 ** zoom
    });
    const layers = [overview, boundingBoxOutline, viewportOutline];
    return layers;
  }
};
OverviewLayer.layerName = "OverviewLayer";
OverviewLayer.defaultProps = defaultProps$3;

function getPosition(boundingBox, position, length) {
  const viewLength = boundingBox[2][0] - boundingBox[0][0];
  switch (position) {
    case "bottom-right": {
      const yCoord = boundingBox[2][1] - (boundingBox[2][1] - boundingBox[0][1]) * length;
      const xLeftCoord = boundingBox[2][0] - viewLength * length;
      return [yCoord, xLeftCoord];
    }
    case "top-right": {
      const yCoord = (boundingBox[2][1] - boundingBox[0][1]) * length;
      const xLeftCoord = boundingBox[2][0] - viewLength * length;
      return [yCoord, xLeftCoord];
    }
    case "top-left": {
      const yCoord = (boundingBox[2][1] - boundingBox[0][1]) * length;
      const xLeftCoord = viewLength * length;
      return [yCoord, xLeftCoord];
    }
    case "bottom-left": {
      const yCoord = boundingBox[2][1] - (boundingBox[2][1] - boundingBox[0][1]) * length;
      const xLeftCoord = viewLength * length;
      return [yCoord, xLeftCoord];
    }
    default: {
      throw new Error(`Position ${position} not found`);
    }
  }
}
const defaultProps$2 = {
  pickable: { type: "boolean", value: true, compare: true },
  viewState: {
    type: "object",
    value: { zoom: 0, target: [0, 0, 0] },
    compare: true
  },
  unit: { type: "string", value: "", compare: true },
  size: { type: "number", value: 1, compare: true },
  position: { type: "string", value: "bottom-right", compare: true },
  length: { type: "number", value: 0.085, compare: true }
};
const ScaleBarLayer = class extends CompositeLayer {
  renderLayers() {
    const { id, unit, size, position, viewState, length } = this.props;
    const boundingBox = makeBoundingBox(viewState);
    const { zoom } = viewState;
    const viewLength = boundingBox[2][0] - boundingBox[0][0];
    const barLength = viewLength * 0.05;
    const barHeight = Math.max(
      2 ** (-zoom + 1.5),
      (boundingBox[2][1] - boundingBox[0][1]) * 7e-3
    );
    const numUnits = barLength * size;
    const [yCoord, xLeftCoord] = getPosition(boundingBox, position, length);
    const lengthBar = new LineLayer({
      id: `scale-bar-length-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [
        [
          [xLeftCoord, yCoord],
          [xLeftCoord + barLength, yCoord]
        ]
      ],
      getSourcePosition: (d) => d[0],
      getTargetPosition: (d) => d[1],
      getWidth: 2,
      getColor: [220, 220, 220]
    });
    const tickBoundsLeft = new LineLayer({
      id: `scale-bar-height-left-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [
        [
          [xLeftCoord, yCoord - barHeight],
          [xLeftCoord, yCoord + barHeight]
        ]
      ],
      getSourcePosition: (d) => d[0],
      getTargetPosition: (d) => d[1],
      getWidth: 2,
      getColor: [220, 220, 220]
    });
    const tickBoundsRight = new LineLayer({
      id: `scale-bar-height-right-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [
        [
          [xLeftCoord + barLength, yCoord - barHeight],
          [xLeftCoord + barLength, yCoord + barHeight]
        ]
      ],
      getSourcePosition: (d) => d[0],
      getTargetPosition: (d) => d[1],
      getWidth: 2,
      getColor: [220, 220, 220]
    });
    const textLayer = new TextLayer({
      id: `units-label-layer-${id}`,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      data: [
        {
          text: numUnits.toPrecision(5) + unit,
          position: [xLeftCoord + barLength * 0.5, yCoord + barHeight * 4]
        }
      ],
      getColor: [220, 220, 220, 255],
      getSize: 12,
      fontFamily: DEFAULT_FONT_FAMILY,
      sizeUnits: "meters",
      sizeScale: 2 ** -zoom,
      characterSet: [
        ...unit.split(""),
        ...range(10).map((i) => String(i)),
        ".",
        "e",
        "+"
      ]
    });
    return [lengthBar, tickBoundsLeft, tickBoundsRight, textLayer];
  }
};
ScaleBarLayer.layerName = "ScaleBarLayer";
ScaleBarLayer.defaultProps = defaultProps$2;

const vs = `#version 300 es
#define SHADER_NAME xr-layer-vertex-shader

// Unit-cube vertices
in vec3 positions;

// Eye position - last column of the inverted view matrix
uniform vec3 eye_pos;
// Projection matrix
uniform mat4 proj;
// Model Matrix
uniform mat4 model;
// View Matrix
uniform mat4 view;
// A matrix for scaling in the model space before any transformations.
// This projects the unit cube up to match the "pixel size" multiplied by the physical size ratio, if provided.
uniform mat4 scale;
uniform mat4 resolution;


out vec3 vray_dir;
flat out vec3 transformed_eye;

void main() {

  // Step 1: Standard MVP transformation (+ the scale matrix) to place the positions on your 2D screen ready for rasterization + fragment processing.
  gl_Position = proj * view * model * scale * resolution * vec4(positions, 1.);

  // Step 2: Invert the eye back from world space to the normalized 0-1 cube world space because ray casting on the fragment shader runs in 0-1 space.
  // Geometrically, the transformed_eye is a position relative to the 0-1 normalized vertices, which themselves are the inverse of the model + scale trasnformation.
  // See below for an example which does not involve a scale transformation, for simplicity, but motivates geometrically the needed transformation on eye_pos.
  /*
  This first diagram is a skewed volume (i.e a "shear" model matrix applied) top down with the eye marked as #, all in world space
       ^
    ___|__
    \\  |  \\
     \\ |   \\
      \\|____\\
       | 
       | 
       |
       #

  This next diagram shows the volume after the inverse model matrix has placed it back in model coordinates, but the eye still in world space. 
       ^
    ___|___
    |  |  |
    |  |  |
    |__|__|
       |
       |
       |
       #

  Finally, we apply the inverse model matrix transformation to the eye as well to bring it too into world space.
  Notice that the ray here matches the "voxels" through which the first ray also passes, as desired.
         ^
    ____/__
    |  /  |
    | /   |
    |/____|
    /
   /
  /
 #
  */
  transformed_eye = (inverse(resolution) * inverse(scale) * inverse(model) * (vec4(eye_pos, 1.))).xyz;

  // Step 3: Rays are from eye to vertices so that they get interpolated over the fragments.
  vray_dir = positions - transformed_eye;
}
`;

const fs = `#version 300 es
precision highp int;
precision highp float;
precision highp SAMPLER_TYPE;

uniform highp SAMPLER_TYPE volume0;
uniform highp SAMPLER_TYPE volume1;
uniform highp SAMPLER_TYPE volume2;
uniform highp SAMPLER_TYPE volume3;
uniform highp SAMPLER_TYPE volume4;
uniform highp SAMPLER_TYPE volume5;

uniform vec3 scaledDimensions;

uniform mat4 scale;

uniform vec3 normals[NUM_PLANES];
uniform float distances[NUM_PLANES];

// color
uniform vec3 colors[6];

// slices
uniform vec2 xSlice;
uniform vec2 ySlice;
uniform vec2 zSlice;

// range
uniform vec2 contrastLimits[6];

in vec3 vray_dir;
flat in vec3 transformed_eye;
out vec4 color;

vec2 intersect_box(vec3 orig, vec3 dir) {
	vec3 box_min = vec3(xSlice[0], ySlice[0], zSlice[0]);
	vec3 box_max = vec3(xSlice[1], ySlice[1], zSlice[1]);
	vec3 inv_dir = 1. / dir;
	vec3 tmin_tmp = (box_min - orig) * inv_dir;
	vec3 tmax_tmp = (box_max - orig) * inv_dir;
	vec3 tmin = min(tmin_tmp, tmax_tmp);
	vec3 tmax = max(tmin_tmp, tmax_tmp);
	float t0 = max(tmin.x, max(tmin.y, tmin.z));
  float t1 = min(tmax.x, min(tmax.y, tmax.z));
  vec2 val = vec2(t0, t1);
	return val;
}

float linear_to_srgb(float x) {
	if (x <= 0.0031308f) {
		return 12.92f * x;
	}
	return 1.055f * pow(x, 1.f / 2.4f) - 0.055f;
}

// Pseudo-random number gen from
// http://www.reedbeta.com/blog/quick-and-easy-gpu-random-numbers-in-d3d11/
// with some tweaks for the range of values
float wang_hash(int seed) {
	seed = (seed ^ 61) ^ (seed >> 16);
	seed *= 9;
	seed = seed ^ (seed >> 4);
	seed *= 0x27d4eb2d;
	seed = seed ^ (seed >> 15);
	return float(seed % 2147483647) / float(2147483647);
}


void main(void) {
	// Step 1: Normalize the view ray
	vec3 ray_dir = normalize(vray_dir);

	// Step 2: Intersect the ray with the volume bounds to find the interval
	// along the ray overlapped by the volume.
	vec2 t_hit = intersect_box(transformed_eye, ray_dir);
	if (t_hit.x > t_hit.y) {
		discard;
	}
	// We don't want to sample voxels behind the eye if it's
	// inside the volume, so keep the starting point at or in front
	// of the eye
	t_hit.x = max(t_hit.x, 0.);

	// Step 3: Compute the step size to march through the volume grid
	vec3 dt_vec = 1. / (scale * vec4(abs(ray_dir), 1.)).xyz;
	float dt = 1. * min(dt_vec.x, min(dt_vec.y, dt_vec.z));

	float offset = wang_hash(int(gl_FragCoord.x + 640. * gl_FragCoord.y));

	// Step 4: Starting from the entry point, march the ray through the volume
	// and sample it
	vec3 p = transformed_eye + (t_hit.x + offset * dt) * ray_dir;

	// TODO: Probably want to stop this process at some point to improve performance when marching down the edges.
	_BEFORE_RENDER
	for (float t = t_hit.x; t < t_hit.y; t += dt) {
		// Check if this point is on the "positive" side or "negative" side of the plane - only show positive.
		float canShow = 1.;
		for (int i = 0; i < NUM_PLANES; i += 1) {
			canShow *= max(0., sign(dot(normals[i], p) + distances[i]));
		}
		// Do not show coordinates outside 0-1 box.
		// Something about the undefined behavior outside the box causes the additive blender to 
		// render some very odd artifacts.
		float canShowXCoordinate = max(p.x - 0., 0.) * max(1. - p.x , 0.);
		float canShowYCoordinate = max(p.y - 0., 0.) * max(1. - p.y , 0.);
		float canShowZCoordinate = max(p.z - 0., 0.) * max(1. - p.z , 0.);
		float canShowCoordinate = float(ceil(canShowXCoordinate * canShowYCoordinate * canShowZCoordinate));
		canShow = canShowCoordinate * canShow;
		float intensityValue0 = float(texture(volume0, p).r);
		DECKGL_PROCESS_INTENSITY(intensityValue0, contrastLimits[0], 0);
		intensityValue0 = canShow * intensityValue0;
		float intensityValue1 = float(texture(volume1, p).r);
		DECKGL_PROCESS_INTENSITY(intensityValue1, contrastLimits[1], 1);
		intensityValue1 = canShow * intensityValue1;
		float intensityValue2 = float(texture(volume2, p).r);
  		DECKGL_PROCESS_INTENSITY(intensityValue2, contrastLimits[2], 2);
		intensityValue2 = canShow * intensityValue2;
		float intensityValue3 = float(texture(volume3, p).r);
  		DECKGL_PROCESS_INTENSITY(intensityValue3, contrastLimits[3], 3);
		intensityValue3 = canShow * intensityValue3;
    	float intensityValue4 = float(texture(volume4, p).r);
  		DECKGL_PROCESS_INTENSITY(intensityValue4, contrastLimits[4], 4);
		intensityValue4 = canShow * intensityValue4;
		float intensityValue5 = float(texture(volume5, p).r);
  		DECKGL_PROCESS_INTENSITY(intensityValue5, contrastLimits[5], 5);
		intensityValue5 = canShow * intensityValue5;

		_RENDER

		p += ray_dir * dt;
	}
	_AFTER_RENDER
  color.r = linear_to_srgb(color.r);
  color.g = linear_to_srgb(color.g);
  color.b = linear_to_srgb(color.b);
}
`;

const channelsModule = {
  name: "channel-intensity-module",
  fs: `    float apply_contrast_limits(float intensity, vec2 contrastLimits) {
      float contrastLimitsAppliedToIntensity = (intensity - contrastLimits[0]) / max(0.0005, (contrastLimits[1] - contrastLimits[0]));
      return max(0., contrastLimitsAppliedToIntensity);
    }
  `
};
const CUBE_STRIP = [
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  1,
  1,
  0,
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  1,
  0,
  1,
  0,
  0,
  1,
  1,
  1,
  1,
  0,
  1,
  0,
  0,
  1,
  1,
  0,
  0,
  0,
  0,
  0
];
const NUM_PLANES_DEFAULT = 1;
const defaultProps$1 = {
  pickable: false,
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  channelData: { type: "object", value: {}, compare: true },
  contrastLimits: { type: "array", value: [], compare: true },
  dtype: { type: "string", value: "Uint8", compare: true },
  xSlice: { type: "array", value: null, compare: true },
  ySlice: { type: "array", value: null, compare: true },
  zSlice: { type: "array", value: null, compare: true },
  clippingPlanes: { type: "array", value: [], compare: true },
  resolutionMatrix: { type: "object", value: new Matrix4(), compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  extensions: {
    type: "array",
    value: [new ColorPalette3DExtensions.AdditiveBlendExtension()],
    compare: true
  }
};
function getRenderingAttrs() {
  const values = getDtypeValues("Float32");
  return {
    ...values,
    sampler: values.sampler.replace("2D", "3D"),
    cast: (data) => new Float32Array(data)
  };
}
function getRenderingFromExtensions(extensions) {
  let rendering = {};
  extensions.forEach((extension) => {
    rendering = extension.rendering;
  });
  if (!rendering._RENDER) {
    throw new Error(
      "XR3DLayer requires at least one extension to define opts.rendering as an object with _RENDER as a property at the minimum."
    );
  }
  return rendering;
}
const XR3DLayer = class extends Layer {
  initializeState() {
    const { gl } = this.context;
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(GL.PACK_ALIGNMENT, 1);
    const programManager = ProgramManager.getDefaultProgramManager(gl);
    const processStr = `fs:DECKGL_PROCESS_INTENSITY(inout float intensity, vec2 contrastLimits, int channelIndex)`;
    if (!programManager._hookFunctions.includes(processStr)) {
      programManager.addShaderHook(processStr);
    }
  }
  _isHookDefinedByExtensions(hookName) {
    const { extensions } = this.props;
    return extensions?.some((e) => {
      const shaders = e.getShaders();
      if (shaders) {
        const { inject = {}, modules = [] } = shaders;
        const definesInjection = inject[hookName];
        const moduleDefinesInjection = modules.some(
          (m) => m.inject && m?.inject[hookName]
        );
        return definesInjection || moduleDefinesInjection;
      }
      return false;
    });
  }
  getShaders() {
    const { clippingPlanes, extensions } = this.props;
    const { sampler } = getRenderingAttrs();
    const { _BEFORE_RENDER, _RENDER, _AFTER_RENDER } = getRenderingFromExtensions(extensions);
    const extensionDefinesDeckglProcessIntensity = this._isHookDefinedByExtensions("fs:DECKGL_PROCESS_INTENSITY");
    const newChannelsModule = { inject: {}, ...channelsModule };
    if (!extensionDefinesDeckglProcessIntensity) {
      newChannelsModule.inject["fs:DECKGL_PROCESS_INTENSITY"] = `
        intensity = apply_contrast_limits(intensity, contrastLimits);
      `;
    }
    return super.getShaders({
      vs,
      fs: fs.replace("_BEFORE_RENDER", _BEFORE_RENDER).replace("_RENDER", _RENDER).replace("_AFTER_RENDER", _AFTER_RENDER),
      defines: {
        SAMPLER_TYPE: sampler,
        NUM_PLANES: String(clippingPlanes.length || NUM_PLANES_DEFAULT)
      },
      modules: [newChannelsModule]
    });
  }
  finalizeState() {
    super.finalizeState();
    if (this.state.textures) {
      Object.values(this.state.textures).forEach((tex) => tex && tex.delete());
    }
  }
  updateState({ props, oldProps, changeFlags }) {
    if (changeFlags.extensionsChanged || props.colormap !== oldProps.colormap || props.renderingMode !== oldProps.renderingMode || props.clippingPlanes.length !== oldProps.clippingPlanes.length) {
      const { gl } = this.context;
      if (this.state.model) {
        this.state.model.delete();
      }
      this.setState({ model: this._getModel(gl) });
    }
    if (props.channelData && props?.channelData?.data !== oldProps?.channelData?.data) {
      this.loadTexture(props.channelData);
    }
  }
  _getModel(gl) {
    if (!gl) {
      return null;
    }
    return new Model(gl, {
      ...this.getShaders(),
      geometry: new Geometry({
        drawMode: gl.TRIANGLE_STRIP,
        attributes: {
          positions: new Float32Array(CUBE_STRIP)
        }
      })
    });
  }
  draw({ uniforms }) {
    const { textures, model, scaleMatrix } = this.state;
    const {
      contrastLimits,
      xSlice,
      ySlice,
      zSlice,
      modelMatrix,
      channelsVisible,
      domain,
      dtype,
      clippingPlanes,
      resolutionMatrix
    } = this.props;
    const { viewMatrix, viewMatrixInverse, projectionMatrix } = this.context.viewport;
    if (textures && model && scaleMatrix) {
      const paddedContrastLimits = padContrastLimits({
        contrastLimits,
        channelsVisible,
        domain,
        dtype
      });
      const invertedScaleMatrix = scaleMatrix.clone().invert();
      const invertedResolutionMatrix = resolutionMatrix.clone().invert();
      const paddedClippingPlanes = padWithDefault(
        clippingPlanes.map(
          (p) => p.clone().transform(invertedScaleMatrix).transform(invertedResolutionMatrix)
        ),
        new Plane([1, 0, 0]),
        clippingPlanes.length || NUM_PLANES_DEFAULT
      );
      const normals = paddedClippingPlanes.map((plane) => plane.normal).flat();
      const distances = paddedClippingPlanes.map((plane) => plane.distance);
      model.setUniforms({
        ...uniforms,
        ...textures,
        contrastLimits: paddedContrastLimits,
        xSlice: new Float32Array(
          xSlice ? xSlice.map((i) => i / scaleMatrix[0] / resolutionMatrix[0]) : [0, 1]
        ),
        ySlice: new Float32Array(
          ySlice ? ySlice.map((i) => i / scaleMatrix[5] / resolutionMatrix[5]) : [0, 1]
        ),
        zSlice: new Float32Array(
          zSlice ? zSlice.map((i) => i / scaleMatrix[10] / resolutionMatrix[10]) : [0, 1]
        ),
        eye_pos: new Float32Array([
          viewMatrixInverse[12],
          viewMatrixInverse[13],
          viewMatrixInverse[14]
        ]),
        view: viewMatrix,
        proj: projectionMatrix,
        scale: scaleMatrix,
        resolution: resolutionMatrix,
        model: modelMatrix || new Matrix4(),
        normals,
        distances
      }).draw();
    }
  }
  loadTexture(channelData) {
    const textures = {
      volume0: null,
      volume1: null,
      volume2: null,
      volume3: null,
      volume4: null,
      volume5: null
    };
    if (this.state.textures) {
      Object.values(this.state.textures).forEach((tex) => tex && tex.delete());
    }
    if (channelData && Object.keys(channelData).length > 0 && channelData.data) {
      const { height, width, depth } = channelData;
      channelData.data.forEach((d, i) => {
        textures[`volume${i}`] = this.dataToTexture(d, width, height, depth);
      }, this);
      this.setState({
        textures,
        scaleMatrix: new Matrix4().scale(
          this.props.physicalSizeScalingMatrix.transformPoint([
            width,
            height,
            depth
          ])
        )
      });
    }
  }
  dataToTexture(data, width, height, depth) {
    const attrs = getRenderingAttrs();
    const texture = new Texture3D(this.context.gl, {
      width,
      height,
      depth,
      data: attrs.cast?.(data) ?? data,
      format: attrs.dataFormat,
      dataFormat: attrs.format,
      type: attrs.type,
      mipmaps: false,
      parameters: {
        [GL.TEXTURE_MIN_FILTER]: GL.LINEAR,
        [GL.TEXTURE_MAG_FILTER]: GL.LINEAR,
        [GL.TEXTURE_WRAP_S]: GL.CLAMP_TO_EDGE,
        [GL.TEXTURE_WRAP_T]: GL.CLAMP_TO_EDGE,
        [GL.TEXTURE_WRAP_R]: GL.CLAMP_TO_EDGE
      }
    });
    return texture;
  }
};
XR3DLayer.layerName = "XR3DLayer";
XR3DLayer.defaultProps = defaultProps$1;

async function getVolume({
  source,
  selection,
  onUpdate = () => {
  },
  downsampleDepth = 1,
  signal
}) {
  const { shape, labels, dtype } = source;
  const { height, width } = getImageSize(source);
  const depth = shape[labels.indexOf("z")];
  const depthDownsampled = Math.max(1, Math.floor(depth / downsampleDepth));
  const rasterSize = height * width;
  const name = `${dtype}Array`;
  const TypedArray = globalThis[name];
  const volumeData = new TypedArray(rasterSize * depthDownsampled);
  await Promise.all(
    new Array(depthDownsampled).fill(0).map(async (_, z) => {
      const depthSelection = {
        ...selection,
        z: z * downsampleDepth
      };
      const { data: rasterData } = await source.getRaster({
        selection: depthSelection,
        signal
      });
      let r = 0;
      onUpdate();
      while (r < rasterSize) {
        const volIndex = z * rasterSize + (rasterSize - r - 1);
        const rasterIndex = (width - r - 1) % width + width * Math.floor(r / width);
        volumeData[volIndex] = rasterData[rasterIndex];
        r += 1;
      }
      onUpdate();
    })
  );
  return {
    data: volumeData,
    height,
    width,
    depth: depthDownsampled
  };
}
const getTextLayer = (text, viewport, id) => {
  return new TextLayer({
    id: `text-${id}`,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    data: [
      {
        text,
        position: viewport.position
      }
    ],
    getColor: [220, 220, 220, 255],
    getSize: 25,
    sizeUnits: "meters",
    sizeScale: 2 ** -viewport.zoom,
    fontFamily: "Helvetica"
  });
};

const defaultProps = {
  pickable: false,
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  contrastLimits: { type: "array", value: [], compare: true },
  channelsVisible: { type: "array", value: [], compare: true },
  selections: { type: "array", value: [], compare: true },
  resolution: { type: "number", value: 0, compare: true },
  domain: { type: "array", value: [], compare: true },
  loader: {
    type: "object",
    value: [
      {
        getRaster: async () => ({ data: [], height: 0, width: 0 }),
        dtype: "Uint16",
        shape: [1],
        labels: ["z"]
      }
    ],
    compare: true
  },
  xSlice: { type: "array", value: null, compare: true },
  ySlice: { type: "array", value: null, compare: true },
  zSlice: { type: "array", value: null, compare: true },
  clippingPlanes: { type: "array", value: [], compare: true },
  onUpdate: { type: "function", value: () => {
  }, compare: true },
  useProgressIndicator: { type: "boolean", value: true, compare: true },
  useWebGL1Warning: { type: "boolean", value: true, compare: true },
  extensions: {
    type: "array",
    value: [new ColorPalette3DExtensions.AdditiveBlendExtension()],
    compare: true
  }
};
const VolumeLayer = class extends CompositeLayer {
  clearState() {
    this.setState({
      height: null,
      width: null,
      depth: null,
      data: null,
      physicalSizeScalingMatrix: null,
      resolutionMatrix: null,
      progress: 0,
      abortController: null
    });
  }
  finalizeState() {
    this.state.abortController.abort();
  }
  updateState({ oldProps, props }) {
    const loaderChanged = props.loader !== oldProps.loader;
    const resolutionChanged = props.resolution !== oldProps.resolution;
    const selectionsChanged = props.selections !== oldProps.selections;
    if (resolutionChanged) {
      this.clearState();
    }
    if (loaderChanged || selectionsChanged || resolutionChanged) {
      const {
        loader,
        selections = [],
        resolution,
        onViewportLoad
      } = this.props;
      const source = loader[resolution];
      let progress = 0;
      const totalRequests = (source.shape[source.labels.indexOf("z")] >> resolution) * selections.length;
      const onUpdate = () => {
        progress += 0.5 / totalRequests;
        if (this.props.onUpdate) {
          this.props.onUpdate({ progress });
        }
        this.setState({ progress });
      };
      const abortController = new AbortController();
      this.setState({ abortController });
      const { signal } = abortController;
      const volumePromises = selections.map(
        (selection) => getVolume({
          selection,
          source,
          onUpdate,
          downsampleDepth: 2 ** resolution,
          signal
        })
      );
      const physicalSizeScalingMatrix = getPhysicalSizeScalingMatrix(
        loader[resolution]
      );
      Promise.all(volumePromises).then((volumes) => {
        if (onViewportLoad) {
          onViewportLoad(volumes);
        }
        const volume = {
          data: volumes.map((d) => d.data),
          width: volumes[0]?.width,
          height: volumes[0]?.height,
          depth: volumes[0]?.depth
        };
        this.setState({
          ...volume,
          physicalSizeScalingMatrix,
          resolutionMatrix: new Matrix4().scale(2 ** resolution)
        });
      });
    }
  }
  renderLayers() {
    const { loader, id, resolution, useProgressIndicator, useWebGL1Warning } = this.props;
    const { dtype } = loader[resolution];
    const {
      data,
      width,
      height,
      depth,
      progress,
      physicalSizeScalingMatrix,
      resolutionMatrix
    } = this.state;
    const { gl } = this.context;
    if (!isWebGL2(gl) && useWebGL1Warning) {
      const { viewport } = this.context;
      return getTextLayer(
        [
          "Volume rendering is only available on browsers that support WebGL2. If you",
          "are using Safari, you can turn on WebGL2 by navigating in the top menubar",
          "to check Develop > Experimental Features > WebGL 2.0 and then refreshing",
          "the page."
        ].join("\n"),
        viewport,
        id
      );
    }
    if (!(width && height) && useProgressIndicator) {
      const { viewport } = this.context;
      return getTextLayer(
        `Loading Volume ${String((progress || 0) * 100).slice(0, 5)}%...`,
        viewport,
        id
      );
    }
    return new XR3DLayer(this.props, {
      channelData: { data, width, height, depth },
      id: `XR3DLayer-${0}-${height}-${width}-${0}-${resolution}-${id}`,
      physicalSizeScalingMatrix,
      parameters: {
        [GL.CULL_FACE]: true,
        [GL.CULL_FACE_MODE]: GL.FRONT,
        [GL.DEPTH_TEST]: false,
        blendFunc: [GL.SRC_ALPHA, GL.ONE],
        blend: true
      },
      resolutionMatrix,
      dtype
    });
  }
};
VolumeLayer.layerName = "VolumeLayer";
VolumeLayer.defaultProps = defaultProps;

export { BitmapLayer, ImageLayer, MultiscaleImageLayer, OverviewLayer, ScaleBarLayer, VolumeLayer, XR3DLayer, XRLayer, getPhysicalSizeScalingMatrix, makeBoundingBox, padWithDefault };

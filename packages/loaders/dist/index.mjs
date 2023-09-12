import { BaseDecoder, GeoTIFFImage, addDecoder, fromFile, fromUrl, fromBlob } from 'geotiff';
import { decompress } from 'lzw-tiff-decoder';
import quickselect from 'quickselect';
import * as parser from 'fast-xml-parser';
import { KeyError, openGroup, BoundsCheckError, slice, HTTPStore } from 'zarr';

const VIV_PROXY_KEY = "__viv";
const OFFSETS_PROXY_KEY = `${VIV_PROXY_KEY}-offsets`;
function checkProxies(tiff) {
  if (!isProxy(tiff, OFFSETS_PROXY_KEY)) {
    console.warn("GeoTIFF source is missing offsets proxy.");
  }
}
function isProxy(tiff, proxyFlag) {
  return tiff[proxyFlag];
}
function createOffsetsProxy(tiff, offsets) {
  const get = (target, key) => {
    if (key === "getImage") {
      return (index) => {
        if (!(index in target.ifdRequests) && index in offsets) {
          const offset = offsets[index];
          target.ifdRequests[index] = target.parseFileDirectoryAt(offset);
        }
        return target.getImage(index);
      };
    }
    if (key === OFFSETS_PROXY_KEY) {
      return true;
    }
    return Reflect.get(target, key);
  };
  return new Proxy(tiff, { get });
}

class LZWDecoder extends BaseDecoder {
  constructor(fileDirectory) {
    super();
    const width = fileDirectory.TileWidth || fileDirectory.ImageWidth;
    const height = fileDirectory.TileLength || fileDirectory.ImageLength;
    const nbytes = fileDirectory.BitsPerSample[0] / 8;
    this.maxUncompressedSize = width * height * nbytes;
  }
  async decodeBlock(buffer) {
    const bytes = new Uint8Array(buffer);
    const decoded = await decompress(bytes, this.maxUncompressedSize);
    return decoded.buffer;
  }
}

const DTYPE_LOOKUP$1 = {
  uint8: "Uint8",
  uint16: "Uint16",
  uint32: "Uint32",
  float: "Float32",
  double: "Float64",
  int8: "Int8",
  int16: "Int16",
  int32: "Int32"
};
function getChannelStats(arr) {
  let len = arr.length;
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  while (len--) {
    if (arr[len] < min) {
      min = arr[len];
    }
    if (arr[len] > max) {
      max = arr[len];
    }
    total += arr[len];
  }
  const mean = total / arr.length;
  len = arr.length;
  let sumSquared = 0;
  while (len--) {
    sumSquared += (arr[len] - mean) ** 2;
  }
  const sd = (sumSquared / arr.length) ** 0.5;
  const mid = Math.floor(arr.length / 2);
  const firstQuartileLocation = Math.floor(arr.length / 4);
  const thirdQuartileLocation = 3 * Math.floor(arr.length / 4);
  quickselect(arr, mid);
  const median = arr[mid];
  quickselect(arr, firstQuartileLocation, 0, mid);
  const q1 = arr[firstQuartileLocation];
  quickselect(arr, thirdQuartileLocation, mid, arr.length - 1);
  const q3 = arr[thirdQuartileLocation];
  const cutoffArr = arr.filter((i) => i > 0);
  const cutoffPercentile = 5e-4;
  const topCutoffLocation = Math.floor(
    cutoffArr.length * (1 - cutoffPercentile)
  );
  const bottomCutoffLocation = Math.floor(cutoffArr.length * cutoffPercentile);
  quickselect(cutoffArr, topCutoffLocation);
  quickselect(cutoffArr, bottomCutoffLocation, 0, topCutoffLocation);
  const contrastLimits = [
    cutoffArr[bottomCutoffLocation] || 0,
    cutoffArr[topCutoffLocation] || 0
  ];
  return {
    mean,
    sd,
    q1,
    q3,
    median,
    domain: [min, max],
    contrastLimits
  };
}
function ensureArray(x) {
  return Array.isArray(x) ? x : [x];
}
function intToRgba(int) {
  if (!Number.isInteger(int)) {
    throw Error("Not an integer.");
  }
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setInt32(0, int, false);
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes);
}
function isInterleaved(shape) {
  const lastDimSize = shape[shape.length - 1];
  return lastDimSize === 3 || lastDimSize === 4;
}
function getLabels(dimOrder) {
  return dimOrder.toLowerCase().split("").reverse();
}
function getDims(labels) {
  const lookup = new Map(labels.map((name, i) => [name, i]));
  if (lookup.size !== labels.length) {
    throw Error("Labels must be unique, found duplicated label.");
  }
  return (name) => {
    const index = lookup.get(name);
    if (index === void 0) {
      throw Error("Invalid dimension.");
    }
    return index;
  };
}
function getImageSize(source) {
  const interleaved = isInterleaved(source.shape);
  const [height, width] = source.shape.slice(interleaved ? -3 : -2);
  return { height, width };
}
function prevPowerOf2(x) {
  return 2 ** Math.floor(Math.log2(x));
}
const SIGNAL_ABORTED = "__vivSignalAborted";
function guessTiffTileSize(image) {
  const tileWidth = image.getTileWidth();
  const tileHeight = image.getTileHeight();
  const size = Math.min(tileWidth, tileHeight);
  return prevPowerOf2(size);
}

function getOmePixelSourceMeta({ Pixels }) {
  const labels = getLabels(Pixels.DimensionOrder);
  const dims = getDims(labels);
  const shape = Array(labels.length).fill(0);
  shape[dims("t")] = Pixels.SizeT;
  shape[dims("c")] = Pixels.SizeC;
  shape[dims("z")] = Pixels.SizeZ;
  if (Pixels.Interleaved) {
    labels.push("_c");
    shape.push(3);
  }
  const getShape = (level) => {
    const s = [...shape];
    s[dims("x")] = Pixels.SizeX >> level;
    s[dims("y")] = Pixels.SizeY >> level;
    return s;
  };
  if (!(Pixels.Type in DTYPE_LOOKUP$1)) {
    throw Error(`Pixel type ${Pixels.Type} not supported.`);
  }
  const dtype = DTYPE_LOOKUP$1[Pixels.Type];
  if (Pixels.PhysicalSizeX && Pixels.PhysicalSizeY) {
    const physicalSizes = {
      x: {
        size: Pixels.PhysicalSizeX,
        unit: Pixels.PhysicalSizeXUnit
      },
      y: {
        size: Pixels.PhysicalSizeY,
        unit: Pixels.PhysicalSizeYUnit
      }
    };
    if (Pixels.PhysicalSizeZ) {
      physicalSizes.z = {
        size: Pixels.PhysicalSizeZ,
        unit: Pixels.PhysicalSizeZUnit
      };
    }
    return { labels, getShape, physicalSizes, dtype };
  }
  return { labels, getShape, dtype };
}
function guessImageDataType(image) {
  const sampleIndex = 0;
  const format = image.fileDirectory.SampleFormat ? image.fileDirectory.SampleFormat[sampleIndex] : 1;
  const bitsPerSample = image.fileDirectory.BitsPerSample[sampleIndex];
  switch (format) {
    case 1:
      if (bitsPerSample <= 8) {
        return DTYPE_LOOKUP$1.uint8;
      }
      if (bitsPerSample <= 16) {
        return DTYPE_LOOKUP$1.uint16;
      }
      if (bitsPerSample <= 32) {
        return DTYPE_LOOKUP$1.uint32;
      }
      break;
    case 2:
      if (bitsPerSample <= 8) {
        return DTYPE_LOOKUP$1.int8;
      }
      if (bitsPerSample <= 16) {
        return DTYPE_LOOKUP$1.int16;
      }
      if (bitsPerSample <= 32) {
        return DTYPE_LOOKUP$1.int32;
      }
      break;
    case 3:
      switch (bitsPerSample) {
        case 16:
          return DTYPE_LOOKUP$1.float;
        case 32:
          return DTYPE_LOOKUP$1.float;
        case 64:
          return DTYPE_LOOKUP$1.double;
      }
      break;
  }
  throw Error("Unsupported data format/bitsPerSample");
}
function getMultiTiffShapeMap(tiffs) {
  let [c, z, t] = [0, 0, 0];
  for (const tiff of tiffs) {
    c = Math.max(c, tiff.selection.c);
    z = Math.max(z, tiff.selection.z);
    t = Math.max(t, tiff.selection.t);
  }
  const firstTiff = tiffs[0].tiff;
  return {
    x: firstTiff.getWidth(),
    y: firstTiff.getHeight(),
    z: z + 1,
    c: c + 1,
    t: t + 1
  };
}
function getChannelSamplesPerPixel(tiffs, numChannels) {
  const channelSamplesPerPixel = Array(numChannels).fill(0);
  for (const tiff of tiffs) {
    const curChannel = tiff.selection.c;
    const curSamplesPerPixel = tiff.tiff.getSamplesPerPixel();
    const existingSamplesPerPixel = channelSamplesPerPixel[curChannel];
    if (existingSamplesPerPixel && existingSamplesPerPixel != curSamplesPerPixel) {
      throw Error("Channel samples per pixel mismatch");
    }
    channelSamplesPerPixel[curChannel] = curSamplesPerPixel;
  }
  return channelSamplesPerPixel;
}
function getMultiTiffMeta(dimensionOrder, tiffs) {
  const firstTiff = tiffs[0].tiff;
  const shapeMap = getMultiTiffShapeMap(tiffs);
  const shape = [];
  for (const dim of dimensionOrder.toLowerCase()) {
    shape.unshift(shapeMap[dim]);
  }
  const labels = getLabels(dimensionOrder);
  const dtype = guessImageDataType(firstTiff);
  return { shape, labels, dtype };
}
function getMultiTiffPixelMedatata(imageNumber, dimensionOrder, shapeMap, dType, tiffs, channelNames, channelSamplesPerPixel) {
  const channelMetadata = [];
  for (let i = 0; i < shapeMap.c; i += 1) {
    channelMetadata.push({
      ID: `Channel:${imageNumber}:${i}`,
      Name: channelNames[i],
      SamplesPerPixel: channelSamplesPerPixel[i]
    });
  }
  return {
    BigEndian: !tiffs[0].tiff.littleEndian,
    DimensionOrder: dimensionOrder,
    ID: `Pixels:${imageNumber}`,
    SizeC: shapeMap.c,
    SizeT: shapeMap.t,
    SizeX: shapeMap.x,
    SizeY: shapeMap.y,
    SizeZ: shapeMap.z,
    Type: dType,
    Channels: channelMetadata
  };
}
function getMultiTiffMetadata(imageName, tiffImages, channelNames, dimensionOrder, dType) {
  const imageNumber = 0;
  const id = `Image:${imageNumber}`;
  const date = "";
  const description = "";
  const shapeMap = getMultiTiffShapeMap(tiffImages);
  const channelSamplesPerPixel = getChannelSamplesPerPixel(
    tiffImages,
    shapeMap.c
  );
  if (channelNames.length !== shapeMap.c)
    throw Error(
      "Wrong number of channel names for number of channels provided"
    );
  const pixels = getMultiTiffPixelMedatata(
    imageNumber,
    dimensionOrder,
    shapeMap,
    dType,
    tiffImages,
    channelNames,
    channelSamplesPerPixel
  );
  const format = () => {
    return {
      "Acquisition Date": date,
      "Dimensions (XY)": `${shapeMap.x} x ${shapeMap.y}`,
      PixelsType: dType,
      "Z-sections/Timepoints": `${shapeMap.z} x ${shapeMap.t}`,
      Channels: shapeMap.c
    };
  };
  return {
    ID: id,
    Name: imageName,
    AcquisitionDate: date,
    Description: description,
    Pixels: pixels,
    format
  };
}
function parseFilename(path) {
  const parsedFilename = {};
  const filename = path.split("/").pop();
  const splitFilename = filename?.split(".");
  if (splitFilename) {
    parsedFilename.name = splitFilename.slice(0, -1).join(".");
    [, parsedFilename.extension] = splitFilename;
  }
  return parsedFilename;
}

const PARSER_OPTIONS = {
  attributeNamePrefix: "",
  attrNodeName: "attr",
  parseNodeValue: true,
  parseAttributeValue: true,
  ignoreAttributes: false
};
const parse = (str) => parser.parse(str, PARSER_OPTIONS);
function fromString(str) {
  const res = parse(str);
  if (!res.OME) {
    throw Error("Failed to parse OME-XML metadata.");
  }
  return ensureArray(res.OME.Image).map((img) => {
    const Channels = ensureArray(img.Pixels.Channel).map((c) => {
      if ("Color" in c.attr) {
        return { ...c.attr, Color: intToRgba(c.attr.Color) };
      }
      return { ...c.attr };
    });
    const { AquisitionDate = "", Description = "" } = img;
    const image = {
      ...img.attr,
      AquisitionDate,
      Description,
      Pixels: {
        ...img.Pixels.attr,
        Channels
      }
    };
    return {
      ...image,
      format() {
        const { Pixels } = image;
        const sizes = ["X", "Y", "Z"].map((name) => {
          const size = Pixels[`PhysicalSize${name}`];
          const unit = Pixels[`PhysicalSize${name}Unit`];
          return size && unit ? `${size} ${unit}` : "-";
        }).join(" x ");
        return {
          "Acquisition Date": image.AquisitionDate,
          "Dimensions (XY)": `${Pixels.SizeX} x ${Pixels.SizeY}`,
          "Pixels Type": Pixels.Type,
          "Pixels Size (XYZ)": sizes,
          "Z-sections/Timepoints": `${Pixels.SizeZ} x ${Pixels.SizeT}`,
          Channels: Pixels.SizeC
        };
      }
    };
  });
}

class TiffPixelSource {
  constructor(indexer, dtype, tileSize, shape, labels, meta, pool) {
    this.dtype = dtype;
    this.tileSize = tileSize;
    this.shape = shape;
    this.labels = labels;
    this.meta = meta;
    this.pool = pool;
    this._indexer = indexer;
  }
  async getRaster({ selection, signal }) {
    const image = await this._indexer(selection);
    return this._readRasters(image, { signal });
  }
  async getTile({ x, y, selection, signal }) {
    const { height, width } = this._getTileExtent(x, y);
    const x0 = x * this.tileSize;
    const y0 = y * this.tileSize;
    const window = [x0, y0, x0 + width, y0 + height];
    const image = await this._indexer(selection);
    return this._readRasters(image, { window, width, height, signal });
  }
  async _readRasters(image, props) {
    const interleave = isInterleaved(this.shape);
    const raster = await image.readRasters({
      interleave,
      ...props,
      pool: this.pool
    });
    if (props?.signal?.aborted) {
      throw SIGNAL_ABORTED;
    }
    const data = interleave ? raster : raster[0];
    return {
      data,
      width: raster.width,
      height: raster.height
    };
  }
  _getTileExtent(x, y) {
    const { height: zoomLevelHeight, width: zoomLevelWidth } = getImageSize(this);
    let height = this.tileSize;
    let width = this.tileSize;
    const maxXTileCoord = Math.floor(zoomLevelWidth / this.tileSize);
    const maxYTileCoord = Math.floor(zoomLevelHeight / this.tileSize);
    if (x === maxXTileCoord) {
      width = zoomLevelWidth % this.tileSize;
    }
    if (y === maxYTileCoord) {
      height = zoomLevelHeight % this.tileSize;
    }
    return { height, width };
  }
  onTileError(err) {
    console.error(err);
  }
}

function getOmeLegacyIndexer(tiff, rootMeta) {
  const { SizeT, SizeC, SizeZ } = rootMeta[0].Pixels;
  const ifdIndexer = getOmeIFDIndexer(rootMeta, 0);
  return (sel, pyramidLevel) => {
    const index = ifdIndexer(sel);
    const pyramidIndex = pyramidLevel * SizeZ * SizeT * SizeC;
    return tiff.getImage(index + pyramidIndex);
  };
}
function getOmeSubIFDIndexer(tiff, rootMeta, image = 0) {
  const ifdIndexer = getOmeIFDIndexer(rootMeta, image);
  const ifdCache = /* @__PURE__ */ new Map();
  return async (sel, pyramidLevel) => {
    const index = ifdIndexer(sel);
    const baseImage = await tiff.getImage(index);
    if (pyramidLevel === 0) {
      return baseImage;
    }
    const { SubIFDs } = baseImage.fileDirectory;
    if (!SubIFDs) {
      throw Error("Indexing Error: OME-TIFF is missing SubIFDs.");
    }
    const key = `${sel.t}-${sel.c}-${sel.z}-${pyramidLevel}`;
    if (!ifdCache.has(key)) {
      const subIfdOffset = SubIFDs[pyramidLevel - 1];
      ifdCache.set(key, tiff.parseFileDirectoryAt(subIfdOffset));
    }
    const ifd = await ifdCache.get(key);
    return new GeoTIFFImage(
      ifd.fileDirectory,
      ifd.geoKeyDirectory,
      baseImage.dataView,
      tiff.littleEndian,
      tiff.cache,
      tiff.source
    );
  };
}
function getOmeIFDIndexer(rootMeta, image = 0) {
  const { SizeC, SizeZ, SizeT, DimensionOrder } = rootMeta[image].Pixels;
  let imageOffset = 0;
  if (image > 0) {
    for (let i = 0; i < image; i += 1) {
      const {
        SizeC: prevSizeC,
        SizeZ: prevSizeZ,
        SizeT: prevSizeT
      } = rootMeta[i].Pixels;
      imageOffset += prevSizeC * prevSizeZ * prevSizeT;
    }
  }
  switch (DimensionOrder) {
    case "XYZCT": {
      return ({ t, c, z }) => imageOffset + t * SizeZ * SizeC + c * SizeZ + z;
    }
    case "XYZTC": {
      return ({ t, c, z }) => imageOffset + c * SizeZ * SizeT + t * SizeZ + z;
    }
    case "XYCTZ": {
      return ({ t, c, z }) => imageOffset + z * SizeC * SizeT + t * SizeC + c;
    }
    case "XYCZT": {
      return ({ t, c, z }) => imageOffset + t * SizeC * SizeZ + z * SizeC + c;
    }
    case "XYTCZ": {
      return ({ t, c, z }) => imageOffset + z * SizeT * SizeC + c * SizeT + t;
    }
    case "XYTZC": {
      return ({ t, c, z }) => imageOffset + c * SizeT * SizeZ + z * SizeT + t;
    }
    default: {
      throw new Error(`Invalid OME-XML DimensionOrder, got ${DimensionOrder}.`);
    }
  }
}
function getMultiTiffIndexer(tiffs) {
  function selectionToKey({ c = 0, t = 0, z = 0 }) {
    return `${c}-${t}-${z}`;
  }
  const lookup = new Map(
    tiffs.map(({ selection, tiff }) => [selectionToKey(selection), tiff])
  );
  return async (sel) => {
    const key = selectionToKey(sel);
    const img = lookup.get(key);
    if (!img)
      throw new Error(`No image available for selection ${key}`);
    return img;
  };
}

function getIndexer$1(tiff, omexml, SubIFDs, image) {
  if (SubIFDs) {
    return getOmeSubIFDIndexer(tiff, omexml, image);
  }
  return getOmeLegacyIndexer(tiff, omexml);
}
async function load$3(tiff, pool) {
  const firstImage = await tiff.getImage(0);
  const {
    ImageDescription,
    SubIFDs,
    PhotometricInterpretation: photometricInterpretation
  } = firstImage.fileDirectory;
  const omexml = fromString(ImageDescription);
  let rootMeta = omexml;
  let levels;
  if (SubIFDs) {
    levels = SubIFDs.length + 1;
  } else {
    levels = omexml.length;
    rootMeta = [omexml[0]];
  }
  const getSource = (resolution, pyramidIndexer, imgMeta) => {
    const { labels, getShape, physicalSizes, dtype } = getOmePixelSourceMeta(imgMeta);
    const tileSize = guessTiffTileSize(firstImage);
    const meta = { photometricInterpretation, physicalSizes };
    const shape = getShape(resolution);
    const indexer = (sel) => pyramidIndexer(sel, resolution);
    const source = new TiffPixelSource(
      indexer,
      dtype,
      tileSize,
      shape,
      labels,
      meta,
      pool
    );
    return source;
  };
  return rootMeta.map((imgMeta, image) => {
    const pyramidIndexer = getIndexer$1(tiff, omexml, SubIFDs, image);
    const data = Array.from({ length: levels }).map(
      (_, resolution) => getSource(resolution, pyramidIndexer, imgMeta)
    );
    return {
      data,
      metadata: imgMeta
    };
  });
}

function assertSameResolution(images) {
  const width = images[0].tiff.getWidth();
  const height = images[0].tiff.getHeight();
  for (const image of images) {
    if (image.tiff.getWidth() !== width || image.tiff.getHeight() !== height) {
      throw new Error(`All images must have the same width and height`);
    }
  }
}
async function assertCompleteStack(images, indexer) {
  for (let t = 0; t <= Math.max(...images.map((i) => i.selection.t)); t += 1) {
    for (let c = 0; c <= Math.max(...images.map((i) => i.selection.c)); c += 1) {
      for (let z = 0; z <= Math.max(...images.map((i) => i.selection.z)); z += 1) {
        await indexer({ t, c, z });
      }
    }
  }
}
async function load$2(imageName, images, channelNames, pool) {
  assertSameResolution(images);
  const firstImage = images[0].tiff;
  const { PhotometricInterpretation: photometricInterpretation } = firstImage.fileDirectory;
  const dimensionOrder = "XYZCT";
  const tileSize = guessTiffTileSize(firstImage);
  const meta = { photometricInterpretation };
  const indexer = getMultiTiffIndexer(images);
  const { shape, labels, dtype } = getMultiTiffMeta(dimensionOrder, images);
  const metadata = getMultiTiffMetadata(
    imageName,
    images,
    channelNames,
    dimensionOrder,
    dtype
  );
  await assertCompleteStack(images, indexer);
  const source = new TiffPixelSource(
    indexer,
    dtype,
    tileSize,
    shape,
    labels,
    meta,
    pool
  );
  return {
    data: [source],
    metadata
  };
}

addDecoder(5, () => LZWDecoder);
const FILE_PREFIX = "file://";
async function loadOmeTiff(source, opts = {}) {
  const { headers = {}, offsets, pool, images = "first" } = opts;
  let tiff;
  if (typeof source === "string") {
    if (source.startsWith(FILE_PREFIX)) {
      tiff = await fromFile(source.slice(FILE_PREFIX.length));
    } else {
      tiff = await fromUrl(source, { headers, cacheSize: Infinity });
    }
  } else {
    tiff = await fromBlob(source);
  }
  if (offsets) {
    tiff = createOffsetsProxy(tiff, offsets);
  }
  checkProxies(tiff);
  const loaders = await load$3(tiff, pool);
  return images === "all" ? loaders : loaders[0];
}
function getImageSelectionName(imageName, imageNumber, imageSelections) {
  return imageSelections.length === 1 ? imageName : imageName + `_${imageNumber.toString()}`;
}
async function loadMultiTiff(sources, opts = {}) {
  const { pool, headers = {}, name = "MultiTiff" } = opts;
  const tiffImage = [];
  const channelNames = [];
  for (const source of sources) {
    const [s, file] = source;
    const imageSelections = Array.isArray(s) ? s : [s];
    if (typeof file === "string") {
      const parsedFilename = parseFilename(file);
      const extension = parsedFilename.extension?.toLowerCase();
      if (extension === "tif" || extension === "tiff") {
        const tiffImageName = parsedFilename.name;
        if (tiffImageName) {
          let curImage;
          if (file.startsWith(FILE_PREFIX)) {
            curImage = await fromFile(file.slice(FILE_PREFIX.length));
          } else {
            curImage = await fromUrl(file, { headers, cacheSize: Infinity });
          }
          for (let i = 0; i < imageSelections.length; i++) {
            const curSelection = imageSelections[i];
            if (curSelection) {
              const tiff = await curImage.getImage(i);
              tiffImage.push({ selection: curSelection, tiff });
              channelNames[curSelection.c] = getImageSelectionName(
                tiffImageName,
                i,
                imageSelections
              );
            }
          }
        }
      }
    } else {
      const { name: name2 } = parseFilename(file.path);
      if (name2) {
        const curImage = await fromBlob(file);
        for (let i = 0; i < imageSelections.length; i++) {
          const curSelection = imageSelections[i];
          if (curSelection) {
            const tiff = await curImage.getImage(i);
            tiffImage.push({ selection: curSelection, tiff });
            channelNames[curSelection.c] = getImageSelectionName(
              name2,
              i,
              imageSelections
            );
          }
        }
      }
    }
  }
  if (tiffImage.length > 0) {
    return load$2(name, tiffImage, opts.channelNames || channelNames, pool);
  }
  throw new Error("Unable to load image from provided TiffFolder source.");
}

function joinUrlParts(...args) {
  return args.map((part, i) => {
    if (i === 0)
      return part.trim().replace(/[/]*$/g, "");
    return part.trim().replace(/(^[/]*|[/]*$)/g, "");
  }).filter((x) => x.length).join("/");
}
class ReadOnlyStore {
  async keys() {
    return [];
  }
  async deleteItem() {
    return false;
  }
  async setItem() {
    console.warn("Cannot write to read-only store.");
    return false;
  }
}
class FileStore extends ReadOnlyStore {
  constructor(fileMap, rootPrefix = "") {
    super();
    this._map = fileMap;
    this._rootPrefix = rootPrefix;
  }
  _key(key) {
    return joinUrlParts(this._rootPrefix, key);
  }
  async getItem(key) {
    const file = this._map.get(this._key(key));
    if (!file) {
      throw new KeyError(key);
    }
    const buffer = await file.arrayBuffer();
    return buffer;
  }
  async containsItem(key) {
    const path = this._key(key);
    return this._map.has(path);
  }
}

function isOmeZarr(dataShape, Pixels) {
  const { SizeT, SizeC, SizeZ, SizeY, SizeX } = Pixels;
  const omeZarrShape = [SizeT, SizeC, SizeZ, SizeY, SizeX];
  return dataShape.every((size, i) => omeZarrShape[i] === size);
}
function guessBioformatsLabels({ shape }, { Pixels }) {
  if (isOmeZarr(shape, Pixels)) {
    return getLabels("XYZCT");
  }
  const labels = getLabels(Pixels.DimensionOrder);
  labels.forEach((lower, i) => {
    const label = lower.toUpperCase();
    const xmlSize = Pixels[`Size${label}`];
    if (!xmlSize) {
      throw Error(`Dimension ${label} is invalid for OME-XML.`);
    }
    if (shape[i] !== xmlSize) {
      throw Error("Dimension mismatch between zarr source and OME-XML.");
    }
  });
  return labels;
}
function getRootPrefix(files, rootName) {
  const first = files.find((f) => f.path.indexOf(rootName) > 0);
  if (!first) {
    throw Error("Could not find root in store.");
  }
  const prefixLength = first.path.indexOf(rootName) + rootName.length;
  return first.path.slice(0, prefixLength);
}
function isAxis(axisOrLabel) {
  return typeof axisOrLabel[0] !== "string";
}
function castLabels(dimnames) {
  return dimnames;
}
async function loadMultiscales(store, path = "") {
  const grp = await openGroup(store, path);
  const rootAttrs = await grp.attrs.asObject();
  let paths = ["0"];
  let labels = castLabels(["t", "c", "z", "y", "x"]);
  if ("multiscales" in rootAttrs) {
    const { datasets, axes } = rootAttrs.multiscales[0];
    paths = datasets.map((d) => d.path);
    if (axes) {
      if (isAxis(axes)) {
        labels = castLabels(axes.map((axis) => axis.name));
      } else {
        labels = castLabels(axes);
      }
    }
  }
  const data = paths.map((path2) => grp.getItem(path2));
  return {
    data: await Promise.all(data),
    rootAttrs,
    labels
  };
}
function guessTileSize(arr) {
  const interleaved = isInterleaved(arr.shape);
  const [yChunk, xChunk] = arr.chunks.slice(interleaved ? -3 : -2);
  const size = Math.min(yChunk, xChunk);
  return prevPowerOf2(size);
}

function getIndexer(labels) {
  const size = labels.length;
  const dims = getDims(labels);
  return (sel) => {
    if (Array.isArray(sel)) {
      return [...sel];
    }
    const selection = Array(size).fill(0);
    for (const [key, value] of Object.entries(sel)) {
      selection[dims(key)] = value;
    }
    return selection;
  };
}

const DTYPE_LOOKUP = {
  u1: "Uint8",
  u2: "Uint16",
  u4: "Uint32",
  f4: "Float32",
  f8: "Float64",
  i1: "Int8",
  i2: "Int16",
  i4: "Int32"
};
class ZarrPixelSource {
  constructor(data, labels, tileSize) {
    this.labels = labels;
    this.tileSize = tileSize;
    this._indexer = getIndexer(labels);
    this._data = data;
    const xChunkSize = data.chunks[this._xIndex];
    const yChunkSize = data.chunks[this._xIndex - 1];
    this._readChunks = tileSize === xChunkSize && tileSize === yChunkSize;
  }
  get shape() {
    return this._data.shape;
  }
  get dtype() {
    const suffix = this._data.dtype.slice(1);
    if (!(suffix in DTYPE_LOOKUP)) {
      throw Error(`Zarr dtype not supported, got ${suffix}.`);
    }
    return DTYPE_LOOKUP[suffix];
  }
  get _xIndex() {
    const interleave = isInterleaved(this._data.shape);
    return this._data.shape.length - (interleave ? 2 : 1);
  }
  _chunkIndex(selection, x, y) {
    const sel = this._indexer(selection);
    sel[this._xIndex] = x;
    sel[this._xIndex - 1] = y;
    return sel;
  }
  _getSlices(x, y) {
    const { height, width } = getImageSize(this);
    const [xStart, xStop] = [
      x * this.tileSize,
      Math.min((x + 1) * this.tileSize, width)
    ];
    const [yStart, yStop] = [
      y * this.tileSize,
      Math.min((y + 1) * this.tileSize, height)
    ];
    if (xStart === xStop || yStart === yStop) {
      throw new BoundsCheckError("Tile slice is zero-sized.");
    }
    return [slice(xStart, xStop), slice(yStart, yStop)];
  }
  async getRaster({ selection }) {
    const sel = this._chunkIndex(selection, null, null);
    const { data, shape } = await this._data.getRaw(sel);
    const [height, width] = shape;
    return { data, width, height };
  }
  async getTile(props) {
    const { x, y, selection, signal } = props;
    let res;
    if (this._readChunks) {
      const sel = this._chunkIndex(selection, x, y);
      res = await this._data.getRawChunk(sel, { storeOptions: { signal } });
    } else {
      const [xSlice, ySlice] = this._getSlices(x, y);
      const sel = this._chunkIndex(selection, xSlice, ySlice);
      res = await this._data.getRaw(sel);
    }
    const {
      data,
      shape: [height, width]
    } = res;
    return { data, width, height };
  }
  onTileError(err) {
    if (!(err instanceof BoundsCheckError)) {
      throw err;
    }
  }
}

async function load$1(root, xmlSource) {
  if (typeof xmlSource !== "string") {
    xmlSource = await xmlSource.text();
  }
  const imgMeta = fromString(xmlSource)[0];
  const { data } = await loadMultiscales(root, "0");
  const labels = guessBioformatsLabels(data[0], imgMeta);
  const tileSize = guessTileSize(data[0]);
  const pyramid = data.map((arr) => new ZarrPixelSource(arr, labels, tileSize));
  return {
    data: pyramid,
    metadata: imgMeta
  };
}

async function load(store) {
  const { data, rootAttrs, labels } = await loadMultiscales(store);
  const tileSize = guessTileSize(data[0]);
  const pyramid = data.map((arr) => new ZarrPixelSource(arr, labels, tileSize));
  return {
    data: pyramid,
    metadata: rootAttrs
  };
}

async function loadBioformatsZarr(source, options = {}) {
  const METADATA = "METADATA.ome.xml";
  const ZARR_DIR = "data.zarr";
  if (typeof source === "string") {
    const url = source.endsWith("/") ? source.slice(0, -1) : source;
    const store2 = new HTTPStore(url + "/" + ZARR_DIR, options);
    const xmlSource = await fetch(url + "/" + METADATA, options.fetchOptions);
    return load$1(store2, xmlSource);
  }
  const fMap = /* @__PURE__ */ new Map();
  let xmlFile;
  for (const file of source) {
    if (file.name === METADATA) {
      xmlFile = file;
    } else {
      fMap.set(file.path, file);
    }
  }
  if (!xmlFile) {
    throw Error("No OME-XML metadata found for store.");
  }
  const store = new FileStore(fMap, getRootPrefix(source, ZARR_DIR));
  return load$1(store, xmlFile);
}
async function loadOmeZarr(source, options = {}) {
  const store = new HTTPStore(source, options);
  if (options?.type !== "multiscales") {
    throw Error("Only multiscale OME-Zarr is supported.");
  }
  return load(store);
}

export { SIGNAL_ABORTED, TiffPixelSource, ZarrPixelSource, getChannelStats, getImageSize, isInterleaved, loadBioformatsZarr, loadMultiTiff, loadOmeTiff, loadOmeZarr };

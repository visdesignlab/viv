**Author's (Ilan's) note**: This is my understanding of the problem and our solutions. If I am mistaken, please feel free to make a pull request. I had literally no background in imaging or rendering before taking this on, but continue to be exhilarated as problems and solutions present themselves.

#### Images and Computers

On some level, images can be thought of simply as `height x width x channels` matrices containing numbers as entries. Computers have three little lights per pixel on the monitor, each of which can take on 256 different values (0-255). For this and definitely other reasons, most images have three (or four) `channels`, RGB (or RGBA where A controls the alpha blending), each with 256 possible values. However, this is somewhat arbitrary - our microscopy data, for example, can have many channels, each corresponding to a different antibody staining that is imaged, and each taking on a far greater range than the standard 256 options. Beyond microscopy, many normal DSLR cameras can take photographs that [go beyond the 256 options as well](https://www.dpbestflow.org/camera/sensor#depth). This data (in a standard 256 bit depth format) is then often compressed (in a [lossless, like .png files via DEFLATE](https://en.wikipedia.org/wiki/Portable_Network_Graphics#Compression), or in a [lossy, like .jpeg files with the Discrete Cosine Transform](https://en.wikipedia.org/wiki/JPEG#JPEG_codec_example), manner) and ready to be transported over the internet or opened on a computer (in both cases, the data must be first decompressed before it can be viewed).

We have thus established that standard image files are 8-bit (256 value-options) `height x width x 3` or `height x width x 4` matrices, often compressed. Our data, as noted, is different, often being 16-bit or 32-bit and taking on more than the standard 3 or 4 channels (or possibly less).

#### Viewing High Resolution Images

A challenge of working in a browser is that you don't have access to data unless it is fed over the internet to you. Thus if you have a very large image in `height` and `width`, storing the entire image in memory is tough. For this reason, people have developed various image **tiling**/**pyramimd** schemes. **Tiling** is the manner in which the underlying image is broken up into smaller images and the **pyramid** represents the image at increasingly downsampled resolutions. This allows you to efficiently view the image in different locations at different zoom levels, given the current viewport in your browser, the most famous example of this being [OpenSeaDragon](https://openseadragon.github.io/).

![Deep Zoom](https://github.com/hms-dbmi/viv/raw/master/docs/deepzoom_example.jpg)

For example, if you are very zoomed in on an image, say the top-left corner of `0:512` in both height and width on the original image, you only need that portion of the image served to your browser for you to view it. You don't need the rest of the image at this moment and should you pan to it, you can always fetch it from the server which contains the output of the **tiling**/**pyramid** generation.

#### Our Data: Problems and solutions

We thus have two main problems: our data is often in a non-standard format, and it is very large. Therefore, we need efficient methods of rendering and serving.

###### 1. Rendering >256 bits of data per channel, with more than 3 channels

To tackle this **_we look to [WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API)_**, a Javascript API for using OpenGL in the browser, as the core technology and **_also [DeckGL](https://deck.gl/#/) as the high-level API_** for our application to communicate "business logic" to WebGL. WebGL is very flexible and will allow us to pass down data (i.e a flattened image matrix) with 16 and 32 bit precision to **shaders**, which can do graphics rendering and basic arithmetic using the GPU very efficiently (this is why deep learning works so well as it relies almost entirely on the GPU). This extended range of 16 or 32 bits can then be mapped by the user to a subset of down to a "0 to 1" range that WebGL can render. Additionally, we can pass down a flag to tell WebGL which color each channel should be mapped to, thus allowing us to store each channel separately.

###### 2. Serving Data Efficiently

Most high resolution tiling image viewing systems rely on `jpeg` files, which can obtain 10:1 compression ratios with imperceptible loss of quality, to serve the image tiles. The `jpeg` files are very small and therefore there is minimal bottleneck with network requests. However, this file type/compression scheme is [not an easy option](https://caniuse.com/#feat=jpegxr) at this moment for more than 8 bits of data per channel in current browsers as they do not ship with the decompression algorithm for more than 8 bit data. However libraries like [zarr.js](https://github.com/gzuidhof/zarr.js) and [geotiff.js](https://github.com/geotiffjs/geotiff.js) could eventually use [an implementation](https://github.com/mozilla/pdf.js/blob/fa4b431091c51a82315dce7da7b848cc6498bcea/src/core/jpg.js) to decode said data. That said, we may not want to lost any precision in what is essentially a scientific measurement, so compression methods — like JPEG — where any information is lost may be a non-starter. The other popular image file type, `png`, achieves considerably worse compression (around 2:1) but is lossless.

Our approach to solving this is twofold.

First, we **_store the image in a compressed, chunked (i.e tiled), "raw" format_** that can be decoded in the browser. For this client-side work, we currently use **zarr** with **[zarr.js](https://github.com/gzuidhof/zarr.js)** and **[geotiff.js](https://github.com/geotiffjs/geotiff.js)**.

**[zarr](https://zarr.readthedocs.io/en/stable/)** provides an interface for reading and writing chunked, compressed, N-dimensional arrays. In other words, **zarr** handles chunking large N-dimensional arrays into compressed [file blobs](https://zarr.readthedocs.io/en/stable/spec/v2.html), each flattened in [row major order](https://en.wikipedia.org/wiki/Row-_and_column-major_order) by default. **Zarr** uses a key-value store (often a file system, where filenames are they keys and the values are the blobs), which makes assembling/indexing the original array efficient, since each chunk is just a small subset of the original array. Taking a step back to see why this is helpful, let us note that images are really (flattened) pixel arrays with a notion of width and height. Thus, JavaScript APIs like **WebGL** and **2D Canvas** rely on flattened array buffers to render images. Since **zarr** can be used to chunk and store a very large image, we can lazily load the zarr-based image data in the browser. This leads to large performance benefits (since pixels can be fetched on a by-chunk basis), and is largely responsible for why **zarr** is becoming a popular image format. It is important to note that **zarr** is originally a python library, but there are an increasing number of implementations in other languages since zarr at its core is a pipeline for storing and accessing blobs of data. We heavily rely on (and have contributed to) [zarr.js](https://github.com/gzuidhof/zarr.js), which is a TypeScript port. By chunking and downsampling large images into **zarr** stores, we create tiled pyramids for lazily loading "raw" image data in the browser. Therefore, given a particular level of the pyramid (i.e. zoom level), we can use the **zarr.js** API directly to request and decode individual compressed chunks (tiles) on the fly. In addition, by chunking additional axes of N-dimensional images (i.e. time, channel), we can lazily load specific image panes from the source (directly!). This provides much finer control over _which_ blobs to access, in contrast to other image formats. `TIFF` files are stored somewhat similarly but rather using the `tiff` file format so all the data lives in one file and then **geotiff.js** makes range requests to get a tile's worth of flattened image data. All this is to say, if you have a method that can store image data in a way that the client can efficiently request a tile's worth of data in one request, you can use that as the "backend" for this project (for example, if you had a `javascript` `hdf5` reader, you could probably use that!).

Second, we believe that **_[HTTP/2](https://en.wikipedia.org/wiki/HTTP/2)_** can help speed up the requests. Even though the requests are not particularly large (normally far less than 2MB per tile with a `512x512` tile size, 16bits of data), there are many of them and in normal HTTP/1, they block one another after a certain point. **HTTP/2** more or less circumvents this blocking problem. A possible extension of this is to use [gRPC](https://en.wikipedia.org/wiki/GRPC) (which uses **HTTP/2** under the hood together with [Protobuf](https://en.wikipedia.org/wiki/Protocol_Buffers)) but for now, **HTTP/2** alone works well enough. We have not tested this too much officially, but we use **GCS** and **s3** for our applications, and they perform comparably, with a slight edge to **GCS** potentially. Below you will find a very rough side-by-side comparison of **s3** vs **GCS**. THe first image is the first request for to the zarr store for image data, and the second image is the last.

###### s3

<img src="https://github.com/hms-dbmi/viv/raw/master/docs/s3FirstRequest.png" width="300" alt="first s3 request"/>
<img src="https://github.com/hms-dbmi/viv/raw/master/docs/s3FinalRequest.png" width="300" alt="last s3 request"/>

###### GCS

<img src="https://github.com/hms-dbmi/viv/raw/master/docs/GCSFirstRequest.png" width="300" alt="first GCS request"/>
<img src="https://github.com/hms-dbmi/viv/raw/master/docs/GCSFinalRequest.png" width="300" alt="last GCS request"/>

#### Pitfalls of other routes

- One possible solution is to use an already existing tiling service, like [mapbox](https://www.mapbox.com) for creating/hosting our data or **OpenSeaDragon** with DeepZoom (or some combination of the two). However, these services does not support high bit-depth-per-channel images. To use these then, we could pack 32 bits per channel (for high bit-depth-per-channel microscopy images) across the total 32 bits of the RGBA of a standard image file and then serve that and decode it, doing some sort of mapping on the shaders. Besides the kludge-y nature of this, we don't save anything really in terms of time as far as transporting the data is concerned, assuming we use `png` - we still need to serve the same amount of data. And, if we attempted to do this with `jpeg` format, it's not clear (to me, a novice) how the color-space transformation, DCT, and entropy encoding will react to what is no longer color values, but rather a bit packing scheme.
- Vector tiles from **mapbox** are another option, relying on **Protobuf**, but our data is not vector data. This raises questions of how we can get the data into that format, and, once it is in that format, why we would not just serve it ourselves over **gRPC** which appears to be faster.
- [OMERO](https://www.openmicroscopy.org/omero/) relies on a client-server model in which the server renders a JPEG/PNG 8-bit RGB image _from_ a source TIFF file. This does not fit the model within which we are trying to develop, in which the server serves chunks of n-bit data which are then rendered on the client.
- There is a high resolution image format called [OpenEXR](https://www.openexr.com/) that supports our data type somewhat natively; that is, it supports high bit-depth-per-channel natively and also supports arbitrary numbers of channels. There is a [ported C++ library](https://github.com/disneyresearch/openexr-wrap-em) as well as a [native Javascript library](https://github.com/mrdoob/three.js/blob/45418089bd5633e856384a8c0beefced87143334/examples/jsm/loaders/EXRLoader.js#L204) for handling these files. There are potentially others. However, unless we use a lossy compression with them, we again don't really gain anything (of note is that **three.js'** implementation, the aforementioned javascript library, does not support lossy compression). A nice thing about the format, though, is that it appears to support image pyramids/tiling natively, although it is not a guarantee that any library we might use does as well (or at least easily). There are two main potential pitfalls with EXR:
  1. The **OpenEXR** format appears to only support three different data types (16 and 32 bit floats, and 32 bit unsigned integers), which means we probably have to kludge our data a bit and will need two different image-serving systems if we get 8-bit data; granted, making an image pyramid requires **_some_** loss of precision anyway (it is essentially a [statistical process](<https://en.wikipedia.org/wiki/Pyramid_(image_processing)>)), so getting from native integers in the OME-TIFF to floating point is not the end of the world, but will likely require we lose precision.
  2. One of the lossy compression schemes it supports is lossy in so far as it just lops of the least significant 8 bits of data (scroll down to the data compression sections [here](https://www.openexr.com/documentation/TechnicalIntroduction.pdf)). The others, while less hacky in this sense, do not work for 32 bit data

#### Helpful Libraries for Data Processing

- **[Bioformats](https://docs.openmicroscopy.org/bio-formats/6.0.1/users/comlinetools/conversion.html)** provides pyramid-writing capabilities for `OME-TIFF` files. With these, you should configure `Viv` to use `geotiff.js`.
- **[Libvips](https://github.com/libvips/libvips)** is another, perhaps lower level, library that can be of service for similar needs.
- **[vitessce-data](https://github.com/hubmapconsortium/vitessce-data/blob/master/python/tile_zarr_base.py)** also contains similar code for writing zarr pyramids.

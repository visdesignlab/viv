declare const MAX_COLOR_INTENSITY = 255;
declare const DEFAULT_COLOR_OFF: number[];
declare const MAX_CHANNELS = 6;
declare const DEFAULT_FONT_FAMILY = "-apple-system, 'Helvetica Neue', Arial, sans-serif";
/**
 * @deprecated We plan to remove `DTYPE_VALUES` as a part of Viv's public API as it
 * leaks internal implementation details. If this is something your project relies
 * on, please open an issue for further discussion.
 *
 * More info can be found here: https://github.com/hms-dbmi/viv/pull/372#discussion_r571707517
 */
declare const DTYPE_VALUES: {
    readonly Uint8: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "usampler2D";
    };
    readonly Uint16: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "usampler2D";
    };
    readonly Uint32: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "usampler2D";
    };
    readonly Float32: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "sampler2D";
    };
    readonly Int8: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "isampler2D";
    };
    readonly Int16: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "isampler2D";
    };
    readonly Int32: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "isampler2D";
    };
    readonly Float64: {
        readonly format: number;
        readonly dataFormat: number;
        readonly type: number;
        readonly max: number;
        readonly sampler: "sampler2D";
        readonly cast: (data: ArrayLike<number>) => Float32Array;
    };
};
declare const COLORMAPS: readonly ["jet", "hsv", "hot", "cool", "spring", "summer", "autumn", "winter", "bone", "copper", "greys", "yignbu", "greens", "yiorrd", "bluered", "rdbu", "picnic", "rainbow", "portland", "blackbody", "earth", "electric", "alpha", "viridis", "inferno", "magma", "plasma", "warm", "rainbow-soft", "bathymetry", "cdom", "chlorophyll", "density", "freesurface-blue", "freesurface-red", "oxygen", "par", "phase", "salinity", "temperature", "turbidity", "velocity-blue", "velocity-green", "cubehelix"];
declare enum RENDERING_MODES {
    MAX_INTENSITY_PROJECTION = "Maximum Intensity Projection",
    MIN_INTENSITY_PROJECTION = "Minimum Intensity Projection",
    ADDITIVE = "Additive"
}

export { COLORMAPS, DEFAULT_COLOR_OFF, DEFAULT_FONT_FAMILY, DTYPE_VALUES, MAX_CHANNELS, MAX_COLOR_INTENSITY, RENDERING_MODES };

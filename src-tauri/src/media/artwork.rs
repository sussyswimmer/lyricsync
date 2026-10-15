//! Bounded image conversion shared by media adapters. Decode on a blocking worker, never the UI thread.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits,
};
use std::io::Cursor;

pub const MAX_ARTWORK_BYTES: usize = 8 * 1024 * 1024;
/// Longest side of the artwork sent to the webviews. The palette samples it at 48×48 and Settings
/// shows it at 14 CSS px; every now-playing event carries it, once a second while playing, and
/// Tauri inlines it into a script each webview parses.
pub const MAX_ARTWORK_SIDE: u32 = 160;
const JPEG_QUALITY: u8 = 85;

/// The cover as a data URL of at most `MAX_ARTWORK_SIDE` px: a JPEG (a photo's is a small fraction
/// of its PNG) unless it has real transparency. That stays a PNG: the palette skips see-through
/// pixels, so flattening them would change its colors.
pub fn to_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > MAX_ARTWORK_BYTES {
        return Err("artwork is empty or exceeds 8 MiB".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|e| e.to_string())?;
    let image = if image.width() > MAX_ARTWORK_SIDE || image.height() > MAX_ARTWORK_SIDE {
        image.thumbnail(MAX_ARTWORK_SIDE, MAX_ARTWORK_SIDE)
    } else {
        image
    };
    let mut encoded = Cursor::new(Vec::new());
    let mime = if is_transparent(&image) {
        image
            .write_to(&mut encoded, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        "png"
    } else {
        // Drops an all-opaque alpha channel; grayscale stays a grayscale JPEG.
        image
            .write_with_encoder(JpegEncoder::new_with_quality(&mut encoded, JPEG_QUALITY))
            .map_err(|e| e.to_string())?;
        "jpeg"
    };
    Ok(format!(
        "data:image/{mime};base64,{}",
        STANDARD.encode(encoded.into_inner())
    ))
}

/// Whether any pixel is less than fully opaque. Checked on the downscaled image, which is cheaper:
/// averaging keeps an opaque cover at full alpha, and even one see-through pixel below it.
fn is_transparent(image: &DynamicImage) -> bool {
    image.color().has_alpha() && image.pixels().any(|(_, _, pixel)| pixel[3] < u8::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Luma, LumaA, Rgb, Rgba, RgbaImage};

    fn encode(image: DynamicImage) -> Vec<u8> {
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Png).unwrap();
        input.into_inner()
    }
    /// The data URL's format and decoded image.
    fn decode(url: &str) -> (&str, DynamicImage) {
        let (mime, data) = url
            .strip_prefix("data:image/")
            .and_then(|rest| rest.split_once(";base64,"))
            .unwrap();
        let bytes = STANDARD.decode(data).unwrap();
        (mime, image::load_from_memory(&bytes).unwrap())
    }
    /// A photo-like cover: smooth gradients with some texture, fully opaque.
    fn photo(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(image::ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([
                (x * 255 / width) as u8,
                (y * 255 / height) as u8,
                ((x * 7 + y * 13) % 64 + 96) as u8,
            ])
        }))
    }

    #[test]
    fn resizes_preserves_aspect_ratio_and_never_upscales() {
        for (width, height, expected) in [
            (640, 400, (160, 100)),
            (600, 400, (160, 107)),
            (100, 150, (100, 150)),
            (400, 800, (80, 160)),
            (3000, 3000, (160, 160)),
        ] {
            for input in [
                DynamicImage::new_rgb8(width, height),
                DynamicImage::new_rgba8(width, height),
            ] {
                let url = to_data_url(&encode(input)).unwrap();
                assert_eq!(decode(&url).1.dimensions(), expected, "{width}×{height}");
            }
        }
    }
    #[test]
    fn opaque_covers_become_jpeg_and_keep_their_colors() {
        // An RGBA PNG whose alpha is all 255, a grayscale cover and a photo-like one.
        let opaque_rgba = RgbaImage::from_pixel(300, 300, Rgba([200, 60, 40, 255]));
        let gray = image::GrayImage::from_pixel(64, 64, Luma([90]));
        for input in [
            DynamicImage::ImageRgba8(opaque_rgba),
            DynamicImage::ImageLuma8(gray),
            photo(300, 300),
        ] {
            let url = to_data_url(&encode(input.clone())).unwrap();
            assert!(
                url.starts_with("data:image/jpeg;base64,"),
                "{:?}",
                input.color()
            );
            let (_, output) = decode(&url);
            if input.color() == image::ColorType::Rgb8 {
                continue;
            }
            // Lossy, but a flat color comes back within a few levels.
            let (got, sent) = (output.get_pixel(40, 40), input.get_pixel(40, 40));
            for channel in 0..3 {
                let delta = i16::from(got[channel]) - i16::from(sent[channel]);
                assert!(delta.abs() <= 4, "{got:?} vs {sent:?}");
            }
        }
        // A fraction of the PNG it replaces, small enough to send every second.
        let jpeg = to_data_url(&encode(photo(300, 300))).unwrap().len();
        let png = STANDARD.encode(encode(photo(160, 160))).len();
        assert!(jpeg * 4 < png, "JPEG {jpeg} vs PNG {png} base64 bytes");
        assert!(jpeg < 12 * 1024, "{jpeg} base64 bytes");
    }
    #[test]
    fn transparent_covers_stay_png_with_their_alpha() {
        // A cut-out cover: the top-left quarter is see-through.
        let cutout = RgbaImage::from_fn(400, 400, |x, y| {
            let alpha = if x < 200 && y < 200 { 0 } else { 255 };
            Rgba([30, 120, 220, alpha])
        });
        let url = to_data_url(&encode(DynamicImage::ImageRgba8(cutout))).unwrap();
        let (mime, output) = decode(&url);
        assert_eq!(mime, "png");
        assert_eq!(output.dimensions(), (160, 160));
        assert_eq!(output.get_pixel(10, 10)[3], 0);
        assert_eq!(output.get_pixel(150, 150), Rgba([30, 120, 220, 255]));
        // One see-through pixel still shows after downscaling; so does partial alpha.
        let mut speck = RgbaImage::from_pixel(400, 400, Rgba([30, 120, 220, 255]));
        speck.put_pixel(399, 399, Rgba([0, 0, 0, 0]));
        let half_alpha = image::ImageBuffer::from_pixel(32, 32, LumaA([128u8, 100]));
        for input in [
            DynamicImage::ImageRgba8(speck),
            DynamicImage::ImageLumaA8(half_alpha),
        ] {
            let url = to_data_url(&encode(input.clone())).unwrap();
            let (mime, output) = decode(&url);
            assert_eq!(mime, "png", "{:?}", input.color());
            assert!(is_transparent(&output));
        }
    }
    #[test]
    fn rejects_invalid_oversized_and_excessive_pixel_dimensions() {
        assert!(to_data_url(b"not an image").is_err());
        assert!(to_data_url(&vec![0; MAX_ARTWORK_BYTES + 1]).is_err());
        assert!(to_data_url(&encode(DynamicImage::new_rgb8(4097, 1))).is_err());
    }
}

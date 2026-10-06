//! Bounded image conversion shared by media adapters. Decode on a blocking worker, never the UI thread.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

pub const MAX_ARTWORK_BYTES: usize = 8 * 1024 * 1024;
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
    let image = if image.width() > 300 || image.height() > 300 {
        image.thumbnail(300, 300)
    } else {
        image
    };
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView};
    #[test]
    fn resizes_preserves_aspect_ratio_and_never_upscales() {
        for (width, height, expected) in [
            (600, 400, (300, 200)),
            (100, 200, (100, 200)),
            (400, 800, (150, 300)),
        ] {
            let mut input = Cursor::new(Vec::new());
            DynamicImage::new_rgba8(width, height)
                .write_to(&mut input, ImageFormat::Png)
                .unwrap();
            let url = to_data_url(input.get_ref()).unwrap();
            let bytes = STANDARD
                .decode(url.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().dimensions(),
                expected
            );
        }
    }
    #[test]
    fn rejects_invalid_oversized_and_excessive_pixel_dimensions() {
        assert!(to_data_url(b"not an image").is_err());
        assert!(to_data_url(&vec![0; MAX_ARTWORK_BYTES + 1]).is_err());
        let mut input = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(4097, 1)
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        assert!(to_data_url(input.get_ref()).is_err());
    }
}

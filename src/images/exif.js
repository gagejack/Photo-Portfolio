// src/images/exif.js
import exifr from 'exifr';

export async function extractDate(buffer, fileMtime) {
  try {
    const meta = await exifr.parse(buffer);

    // First, check named properties for a valid Date
    const raw = meta?.DateTimeOriginal ?? meta?.CreateDate;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return { takenAt: raw.toISOString(), source: 'exif' };
    }

    // Fallback: check numeric tag keys (36867 = DateTimeOriginal, 36868 = DateTimeDigitized)
    const rawString = meta?.[36867] ?? meta?.[36868];
    if (typeof rawString === 'string') {
      // Convert from "2025:07:14 09:30:00" format to ISO 8601
      // EXIF DateTimeOriginal carries no timezone, we treat it as UTC,
      // which is acceptable here because only year and month are ever displayed.
      const dateStr = rawString.split(' ').map((part, i) => i === 0 ? part.replace(/:/g, '-') : part).join('T') + 'Z';
      const date = new Date(dateStr);
      if (!Number.isNaN(date.getTime())) {
        return { takenAt: date.toISOString(), source: 'exif' };
      }
    }
  } catch {
    // Unreadable or absent EXIF is expected for screenshots, scans, and
    // stripped files. Fall through to the mtime fallback.
  }

  return { takenAt: new Date(fileMtime).toISOString(), source: 'mtime' };
}

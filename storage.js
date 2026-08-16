// Receipt photo storage on Vercel Blob. Serverless filesystems are ephemeral,
// so images go to object storage instead of local disk. If Blob isn't
// configured the app still works — receipts just have no photo attached.

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

export function blobEnabled() { return Boolean(TOKEN); }

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Returns the public URL of the stored image, or null when storage is off.
export async function putReceiptImage(receiptId, buffer, mediaType) {
  if (!blobEnabled()) return null;
  const { put } = await import('@vercel/blob');
  const ext = EXT[mediaType] || 'jpg';
  const { url } = await put(`receipts/${receiptId}.${ext}`, buffer, {
    access: 'public',
    contentType: mediaType,
    token: TOKEN,
    addRandomSuffix: true, // avoids collisions and stale-cache surprises
  });
  return url;
}

export async function deleteReceiptImage(url) {
  if (!blobEnabled() || !url) return;
  const { del } = await import('@vercel/blob');
  await del(url, { token: TOKEN });
}

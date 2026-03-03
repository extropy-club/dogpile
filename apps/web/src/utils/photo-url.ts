const R2_PHOTOS_DOMAIN = import.meta.env.PUBLIC_R2_PHOTOS_DOMAIN || "https://dogpile.extropy.club"
const R2_GENERATED_DOMAIN = import.meta.env.DEV 
  ? "http://localhost:8787/photos/generated"
  : "https://dogpile-generated.extropy.club"

export type PhotoSize = "sm" | "lg"

export function getPhotoUrl(photoKey: string, size: PhotoSize): string {
  if (photoKey.startsWith("http")) {
    return photoKey
  }

  if (photoKey.startsWith("generated/")) {
    const key = photoKey.slice("generated/".length)
    return `${R2_GENERATED_DOMAIN}/${key}-${size}.webp`
  }

  return `${R2_PHOTOS_DOMAIN}/${photoKey}-${size}.webp`
}

export function getPhotoSrcSet(photoKey: string): string | undefined {
  // External URLs don't need srcset - browser will use the full URL directly
  if (photoKey.startsWith("http")) {
    return undefined
  }

  const sm = getPhotoUrl(photoKey, "sm")
  const lg = getPhotoUrl(photoKey, "lg")
  return `${sm} 400w, ${lg} 1200w`
}

import {createClient} from 'next-sanity'

export const sanityClient = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "1660070g",
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || "production",
  apiVersion: '2024-08-13',
  useCdn: true, // Sanity's CDN (~60s staleness) — page-level ISR controls freshness now
})

export async function getSanityProducts() {
  const query = `*[_type == "product"]{
    _id,
    searchCode,
    category,
    subCategory,
    "images": images[].asset->url
  }`
  // No cache: 'no-store' — it opted entire routes out of ISR, forcing per-request
  // SSR for every page that touched Sanity (root cause of the Nov 2026 bandwidth
  // incident's uncached homepage). Page revalidate segments now control freshness.
  return sanityClient.fetch(query, {})
}

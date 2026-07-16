// FILE: app/lib/productMeta.server.ts
export const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;
export const MEDIA_IMAGE_GID_RE = /^gid:\/\/shopify\/MediaImage\/\d+$/;

export interface ProductMetaWithImages {
  id: string;
  title: string;
  productType: string;
  vendor: string;
  tags: string[];
  images: { id: string; url: string; altText: string | null }[];
}

export async function fetchProductMeta(
  adminGraphql: (query: string, opts?: any) => Promise<Response>,
  productGid: string,
): Promise<ProductMetaWithImages | null> {
  const resp = await adminGraphql(
    `#graphql
    query ProductMeta($id: ID!) {
      product(id: $id) {
        id title productType vendor tags
        media(first: 50) {
          edges { node { id alt ... on MediaImage { image { url } } } }
        }
      }
    }`,
    { variables: { id: productGid } },
  );

  const gql = await resp.json();
  const p = gql?.data?.product;
  if (!p) return null;

  const images = (p.media?.edges ?? [])
    .map((e: any) => e.node)
    .filter((n: any) => n?.image?.url)
    .map((n: any) => ({ id: n.id, url: n.image.url, altText: n.alt ?? null }));

  return { id: p.id, title: p.title, productType: p.productType, vendor: p.vendor, tags: p.tags, images };
}
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Select,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
  Toast,
  Frame,
} from "@shopify/polaris";

import { useFetcher } from "@remix-run/react";
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { useState, useEffect } from "react";

const TONE_OPTIONS = [
  { label: "Neutral", value: "neutral" },
  { label: "Luxury", value: "luxury" },
  { label: "Friendly", value: "friendly" },
  { label: "Professional", value: "professional" },
  { label: "Playful", value: "playful" },
];


// ==================
// ACTION (Server)
// ==================
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "generate-description") {
    const title = formData.get("title");
    const details = formData.get("details");

    const generated = `Discover ${title || "this product"} — crafted to deliver real value. ${
      details ? `Highlights: ${details}` : ""
    }`.trim();

    return json({ type: "description", generated });
  }

  if (intent === "generate-meta") {
    const title = formData.get("title");
    const keyword = formData.get("keyword");

    return json({
      type: "meta",
      metaTitle: `${keyword ? `${keyword} ` : ""}${title || "Product"} | Your Store`,
      metaDescription: `Shop ${title || "this product"} with fast shipping and great value.`,
    });
  }

  return json({});
}


// ==================
// COMPONENT
// ==================
export default function GeneratePage() {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  const [toast, setToast] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [tone, setTone] = useState("neutral");
  const [details, setDetails] = useState("");

  const [generatedDescription, setGeneratedDescription] = useState("");

  const [keyword, setKeyword] = useState("");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");

  useEffect(() => {
    if (fetcher.data?.type === "description") {
      setGeneratedDescription(fetcher.data.generated);
      setToast("Description generated.");
    }

    if (fetcher.data?.type === "meta") {
      setMetaTitle(fetcher.data.metaTitle);
      setMetaDescription(fetcher.data.metaDescription);
      setToast("Meta tags generated.");
    }
  }, [fetcher.data]);

  return (
    <Frame>
      {toast && <Toast content={toast} onDismiss={() => setToast(null)} />}

      <Page title="AI Product Generator">
        <Layout>

          {/* LEFT SIDE */}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Generate Product Description
                </Text>

                <TextField label="Product Title" value={title} onChange={setTitle} />
                <Select label="Tone" options={TONE_OPTIONS} value={tone} onChange={setTone} />
                <TextField
                  label="Details"
                  value={details}
                  onChange={setDetails}
                  multiline={4}
                />

                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="generate-description" />
                  <input type="hidden" name="title" value={title} />
                  <input type="hidden" name="details" value={details} />

                  <Button submit variant="primary" loading={busy}>
                    Generate Description
                  </Button>
                </fetcher.Form>

                {generatedDescription && (
                  <Card background="bg-surface-secondary">
                    <Text as="p">{generatedDescription}</Text>
                  </Card>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>


          {/* RIGHT SIDE - META */}
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Generate Meta Tags
                </Text>

                <TextField label="Keyword" value={keyword} onChange={setKeyword} />

                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="generate-meta" />
                  <input type="hidden" name="title" value={title} />
                  <input type="hidden" name="keyword" value={keyword} />

                  <Button submit variant="primary" loading={busy}>
                    Generate Meta
                  </Button>
                </fetcher.Form>

                {metaTitle && (
                  <>
                    <Text as="p"><strong>Meta Title:</strong> {metaTitle}</Text>
                    <Text as="p"><strong>Meta Description:</strong> {metaDescription}</Text>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

        </Layout>
        <Divider />
      </Page>
    </Frame>
  );
}

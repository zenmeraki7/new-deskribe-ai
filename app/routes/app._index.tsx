import { useState, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Select,
  TextField,
  Tabs,
  Divider,
  Spinner,
  Box,
} from "@shopify/polaris";

const SAMPLE_DESCRIPTION = `Elevate your daily routine with our handcrafted ceramic mug, designed for those who appreciate the finer details. Made from premium stoneware clay and finished with a rich forest-green glaze, each piece is unique — the natural variations in texture and tone make yours truly one of a kind.

The ergonomic handle is thoughtfully shaped for a comfortable grip, while the wide mouth lets you enjoy the full aroma of your favorite brew. Microwave and dishwasher safe, this mug is as practical as it is beautiful.

Perfect as a gift or a treat for yourself.`;

export default function DescriptionGenerator() {
  const [tone, setTone] = useState("Conversational");
  const [length, setLength] = useState("Medium");
  const [audience, setAudience] = useState("General Shoppers");
  const [keywords, setKeywords] = useState("");
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);

  const tones = ["Conversational", "Luxury", "Minimal", "Bold"];
  const lengths = ["Short", "Medium", "Long"];

  const tabs = [
    { id: "a", content: "Version A" },
    { id: "b", content: "Version B" },
    { id: "c", content: "Version C" },
  ];

  const handleGenerate = () => {
    setLoading(true);
    setGenerated(false);
    setTimeout(() => {
      setLoading(false);
      setGenerated(true);
    }, 1800);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(SAMPLE_DESCRIPTION);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const wordCount = useMemo(
    () => SAMPLE_DESCRIPTION.trim().split(/\s+/).length,
    []
  );

  const charCount = SAMPLE_DESCRIPTION.length;

  return (
    <Page
      title="DescribeAI"
      subtitle="Product Description Generator"
      primaryAction={{
        content: "Generate Description",
        onAction: handleGenerate,
        loading,
      }}
    >
      <Layout>
        <Layout.Section>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 2fr",
              gap: "16px",
              alignItems: "start",
            }}
          >
            {/* LEFT — Product Card */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Selected Product
                </Text>

                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="0"
                  overflow="hidden"
                >
                  <div
                    style={{
                      width: "100%",
                      aspectRatio: "1 / 1",
                      background:
                        "linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 50%, #a5d6a7 100%)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                      cursor: "pointer",
                    }}
                  >
                    <svg
                      width="48"
                      height="48"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#4caf50"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M17 8h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2" />
                      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
                      <line x1="6" y1="2" x2="6" y2="4" />
                      <line x1="10" y1="2" x2="10" y2="4" />
                      <line x1="14" y1="2" x2="14" y2="4" />
                    </svg>
                    <Text variant="bodySm" tone="subdued">
                      Forest Ceramic Mug
                    </Text>
                  </div>
                </Box>

                <BlockStack gap="150">
                  <Text variant="headingMd" as="h3">
                    Forest Ceramic Mug
                  </Text>
                  <Text variant="bodySm" tone="subdued">
                    SKU: MUG-FG-001
                  </Text>
                  <InlineStack gap="100" wrap>
                    <Badge>Handcrafted</Badge>
                    <Badge>Stoneware</Badge>
                    <Badge>12oz</Badge>
                  </InlineStack>
                </BlockStack>

                <Button fullWidth>Change Product</Button>
              </BlockStack>
            </Card>

            {/* RIGHT — Generation Settings + Generated Output stacked */}
            <BlockStack gap="400">

              {/* Generation Settings */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingSm">
                    Generation Settings
                  </Text>

                  <InlineStack gap="400">
                    <BlockStack gap="200">
                      <Text variant="bodyMd">Tone of Voice</Text>
                      <InlineStack gap="200">
                        {tones.map((t) => (
                          <Button
                            key={t}
                            pressed={tone === t}
                            onClick={() => setTone(t)}
                            size="slim"
                          >
                            {t}
                          </Button>
                        ))}
                      </InlineStack>
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text variant="bodyMd">Description Length</Text>
                      <InlineStack gap="200">
                        {lengths.map((l) => (
                          <Button
                            key={l}
                            pressed={length === l}
                            onClick={() => setLength(l)}
                            size="slim"
                          >
                            {l}
                          </Button>
                        ))}
                      </InlineStack>
                    </BlockStack>
                  </InlineStack>

                  <Select
                    label="Target Audience"
                    options={[
                      { label: "General Shoppers", value: "General Shoppers" },
                      { label: "Gift Buyers", value: "Gift Buyers" },
                      { label: "Home & Living Enthusiasts", value: "Home & Living Enthusiasts" },
                      { label: "Minimalist Lifestyle", value: "Minimalist Lifestyle" },
                    ]}
                    value={audience}
                    onChange={setAudience}
                  />

                  <TextField
                    label="Keywords to Include"
                    value={keywords}
                    onChange={setKeywords}
                    autoComplete="off"
                    placeholder="e.g. handmade, eco-friendly..."
                  />
                </BlockStack>
              </Card>

              {/* Generated Output */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text variant="headingSm" as="h2">
                      Generated Output
                    </Text>

                    {generated && (
                      <InlineStack gap="200">
                        <Button size="slim" onClick={handleCopy}>
                          {copied ? "Copied ✓" : "Copy"}
                        </Button>
                        <Button size="slim" variant="primary">
                          Push to Shopify
                        </Button>
                      </InlineStack>
                    )}
                  </InlineStack>

                  <Divider />

                  {loading ? (
                    <Box padding="600">
                      <InlineStack align="center">
                        <Spinner size="large" />
                      </InlineStack>
                    </Box>
                  ) : generated ? (
                    <>
                      <Tabs
                        tabs={tabs}
                        selected={activeTab}
                        onSelect={setActiveTab}
                      />
                      <Text as="p" variant="bodyMd">
                        {SAMPLE_DESCRIPTION}
                      </Text>

                      <Divider />

                      <InlineStack gap="600">
                        <BlockStack gap="050">
                          <Text variant="headingMd">{wordCount}</Text>
                          <Text variant="bodySm" tone="subdued">Words</Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">{charCount}</Text>
                          <Text variant="bodySm" tone="subdued">Characters</Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">92</Text>
                          <Text variant="bodySm" tone="subdued">SEO Score</Text>
                        </BlockStack>
                        <BlockStack gap="050">
                          <Text variant="headingMd">{tone}</Text>
                          <Text variant="bodySm" tone="subdued">Tone</Text>
                        </BlockStack>
                      </InlineStack>
                    </>
                  ) : (
                    <Box padding="400">
                      <InlineStack align="center">
                        <Text tone="subdued">
                          Configure settings and generate a description
                        </Text>
                      </InlineStack>
                    </Box>
                  )}
                </BlockStack>
              </Card>

            </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  EmptyState,
  Box,
  Divider,
} from "@shopify/polaris";
import { Trash2, Calendar, Tag, Hash } from "lucide-react";
import { authenticate } from "../shopify.server";
import { getHistory, clearHistory, deleteHistoryEntry } from "../services/history.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const history = await getHistory();
  return json({ history });
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  if (action === "delete") {
    const id = String(formData.get("id"));
    await deleteHistoryEntry(id);
    return json({ success: true });
  }

  if (action === "clearAll") {
    await clearHistory();
    return json({ success: true });
  }

  return json({ success: false }, { status: 400 });
}

export default function HistoryPage() {
  const { history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const handleDelete = (id: string) => {
    if (confirm("Delete this history entry?")) {
      fetcher.submit(
        { action: "delete", id },
        { method: "post" }
      );
    }
  };

  const handleClearAll = () => {
    if (confirm("Delete all history? This cannot be undone.")) {
      fetcher.submit(
        { action: "clearAll" },
        { method: "post" }
      );
    }
  };

  return (
    <Page
      title="Generation History"
      subtitle={`${history.length} generation${history.length !== 1 ? 's' : ''}`}
      secondaryActions={
        history.length > 0
          ? [
              {
                content: "Clear All",
                destructive: true,
                onAction: handleClearAll,
              },
            ]
          : []
      }
    >
      {history.length === 0 ? (
        <Card>
          <EmptyState
            heading="No generation history yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <Text as="p">
              When you generate product descriptions, they'll appear here.
            </Text>
          </EmptyState>
        </Card>
      ) : (
        <BlockStack gap="400">
          {history.map((item) => (
            <Card key={item.id}>
              <BlockStack gap="400">
                {/* Header */}
                <InlineStack align="space-between" blockAlign="start">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd" fontWeight="semibold">
                      {item.productTitle}
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="info">
                        <InlineStack gap="100" blockAlign="center">
                          <Tag size={12} />
                          <Text as="span">{item.vibe}</Text>
                        </InlineStack>
                      </Badge>
                      <Badge>
                        <InlineStack gap="100" blockAlign="center">
                          <Hash size={12} />
                          <Text as="span">{item.format}</Text>
                        </InlineStack>
                      </Badge>
                      {item.keywords && (
                        <Badge tone="attention">
                          <Text as="span">{item.keywords}</Text>
                        </Badge>
                      )}
                    </InlineStack>
                  </BlockStack>

                  <Button
                    onClick={() => handleDelete(item.id)}
                    tone="critical"
                    variant="plain"
                  >
                    <Trash2 size={16} />
                  </Button>
                </InlineStack>

                <Divider />

                {/* Generated Content */}
                <Box
                  background="bg-surface-secondary"
                  padding="400"
                  borderRadius="200"
                >
                  <div
                    dangerouslySetInnerHTML={{ __html: item.description }}
                  />
                </Box>

                {/* Social Media Content */}
                {item.socials && (
                  <Box
                    background="bg-surface-secondary"
                    padding="400"
                    borderRadius="200"
                  >
                    <BlockStack gap="300">
                      <Text as="h4" variant="headingSm" fontWeight="semibold">
                        Social Media Captions
                      </Text>
                      {item.socials.twitter && (
                        <Box>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            Twitter / X
                          </Text>
                          <Text as="p" variant="bodyMd">
                            {item.socials.twitter}
                          </Text>
                        </Box>
                      )}
                      {item.socials.instagram && (
                        <Box>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            Instagram
                          </Text>
                          <Text as="p" variant="bodyMd">
                            {item.socials.instagram}
                          </Text>
                        </Box>
                      )}
                    </BlockStack>
                  </Box>
                )}

                {/* Footer */}
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Calendar size={14} />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                  </InlineStack>

                  <Text as="p" variant="bodySm" tone="subdued">
                    Product ID: {item.productId.split("/").pop()}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          ))}
        </BlockStack>
      )}
    </Page>
  );
}
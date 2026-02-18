import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
} from "@shopify/polaris";

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { db } from "../lib/db.server";


// =======================
// LOADER
// =======================
export async function loader({ request }: LoaderFunctionArgs) {
  const [
    totalJobs,
    completedJobs,
    failedJobs,
    pendingJobs,
    totalHistory,
    latestJobs,
  ] = await Promise.all([
    db.generationJob.count(),
    db.generationJob.count({ where: { status: "completed" } }),
    db.generationJob.count({ where: { status: "failed" } }),
    db.generationJob.count({ where: { status: "pending" } }),
    db.history.count(),
    db.generationJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  return json({
    totalJobs,
    completedJobs,
    failedJobs,
    pendingJobs,
    totalHistory,
    latestJobs,
  });
}


// =======================
// COMPONENT
// =======================
export default function Dashboard() {
  const {
    totalJobs,
    completedJobs,
    failedJobs,
    pendingJobs,
    totalHistory,
    latestJobs,
  } = useLoaderData<typeof loader>();

  const rows = latestJobs.map((job) => [
    job.productTitle,
    job.status,
    new Date(job.createdAt).toLocaleString(),
  ]);

  return (
    <Page title="AI Dashboard">

      <Layout>

        {/* STATS CARDS */}
        <Layout.Section>
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h2">Total Jobs</Text>
                  <Text variant="heading2xl" as="p">{totalJobs}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h2">Completed</Text>
                  <InlineStack gap="200" align="space-between">
                    <Text variant="heading2xl" as="p">{completedJobs}</Text>
                    <Badge tone="success">Done</Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h2">Failed</Text>
                  <InlineStack gap="200" align="space-between">
                    <Text variant="heading2xl" as="p">{failedJobs}</Text>
                    <Badge tone="critical">Error</Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        </Layout.Section>

        {/* SECOND ROW */}
        <Layout.Section>
          <Layout>
            <Layout.Section variant="oneHalf">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h2">Pending Jobs</Text>
                  <InlineStack gap="200" align="space-between">
                    <Text variant="heading2xl" as="p">{pendingJobs}</Text>
                    <Badge tone="attention">Processing</Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneHalf">
              <Card>
                <BlockStack gap="200">
                  <Text variant="headingMd" as="h2">History Entries</Text>
                  <Text variant="heading2xl" as="p">{totalHistory}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        </Layout.Section>

        {/* LATEST JOBS TABLE */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                Latest Generation Jobs
              </Text>

              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Product", "Status", "Created At"]}
                rows={rows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}

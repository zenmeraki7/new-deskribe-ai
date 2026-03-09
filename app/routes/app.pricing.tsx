import { Form, useNavigation } from "@remix-run/react";
import { Page, Card, Button, Text } from "@shopify/polaris";

export default function PricingPage() {
  const navigation = useNavigation();

  return (
    <Page title="Choose a Plan">
      <Card>
        <Text variant="headingMd">Basic Plan - $9/month</Text>

        <Form method="post" action="/app/subscribe">
          <input type="hidden" name="plan" value="BASIC" />
          <Button submit loading={navigation.state === "submitting"}>
            Subscribe
          </Button>
        </Form>
      </Card>

      <Card>
        <Text variant="headingMd">Pro Plan - $29/month</Text>

        <Form method="post" action="/app/subscribe">
          <input type="hidden" name="plan" value="PRO" />
          <Button submit>Subscribe</Button>
        </Form>
      </Card>
    </Page>
  );
}
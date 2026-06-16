import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { CREDIT_COSTS } from "../../lib/credits";
import { formatCredits } from "../../utils/formatCredits";
import {
  MAX_KEYWORD_CHARS,
  MAX_KEYWORDS,
  MAX_KEYWORDS_INPUT_CHARS,
  type BulkKeywordResult,
  type KeywordParseResult,
} from "./bulkGenerateModal.types";

export function BulkKeywordSection({
  keywordsInput,
  normalizedKeywords,
  keywordParseResult,
  suggestedKeywords,
  isSubmitting,
  isSuggestingKeywords,
  count,
  exceedsProductLimit,
  suggestionCreditWarning,
  visibleKeywordResult,
  onKeywordsChange,
  onSuggest,
  onAddSuggestedKeyword,
  onRemoveKeyword,
}: {
  keywordsInput: string;
  normalizedKeywords: string[];
  keywordParseResult: KeywordParseResult;
  suggestedKeywords: string[];
  isSubmitting: boolean;
  isSuggestingKeywords: boolean;
  count: number;
  exceedsProductLimit: boolean;
  suggestionCreditWarning: boolean;
  visibleKeywordResult: BulkKeywordResult | undefined;
  onKeywordsChange: (value: string) => void;
  onSuggest: () => void;
  onAddSuggestedKeyword: (keyword: string) => void;
  onRemoveKeyword: (keyword: string) => void;
}) {
  const keywordAdjustmentVisible =
    keywordParseResult.ignoredCount > 0 ||
    keywordParseResult.truncatedInput ||
    keywordParseResult.truncatedKeywordsCount > 0;

  return (
    <Card>
      <BlockStack gap="300">
        <TextField
          label="Keywords"
          value={keywordsInput}
          onChange={onKeywordsChange}
          placeholder="organic cotton, eco-friendly, sustainable"
          autoComplete="off"
          disabled={isSubmitting}
          maxLength={MAX_KEYWORDS_INPUT_CHARS}
          helpText={`Optional. Maximum ${MAX_KEYWORDS} keywords, ${MAX_KEYWORD_CHARS} characters each.`}
          connectedRight={
            <Button
              onClick={onSuggest}
              loading={isSuggestingKeywords}
              disabled={
                isSubmitting ||
                isSuggestingKeywords ||
                count === 0 ||
                exceedsProductLimit
              }
            >
              Suggest
            </Button>
          }
        />

        <Text as="p" variant="bodySm" tone="subdued">
          Keyword suggestions cost{" "}
          {formatCredits(CREDIT_COSTS.keywordSuggestion)} credits.
        </Text>

        {suggestionCreditWarning && (
          <Banner tone="warning" title="Not enough credits">
            Keyword suggestions require{" "}
            {formatCredits(CREDIT_COSTS.keywordSuggestion)} credits.
          </Banner>
        )}

        {keywordAdjustmentVisible && (
          <Banner tone="warning" title="Some keywords were adjusted">
            <Text as="p" variant="bodySm">
              {normalizedKeywords.length} accepted
              {keywordParseResult.ignoredCount > 0
                ? `, ${keywordParseResult.ignoredCount} ignored`
                : ""}
              {keywordParseResult.truncatedKeywordsCount > 0
                ? `, ${keywordParseResult.truncatedKeywordsCount} shortened`
                : ""}
              .
            </Text>
          </Banner>
        )}

        {normalizedKeywords.length > 0 && (
          <InlineStack gap="100" wrap>
            {normalizedKeywords.map((keyword) => (
              <Tag
                key={keyword}
                onRemove={
                  isSubmitting ? undefined : () => onRemoveKeyword(keyword)
                }
              >
                {keyword}
              </Tag>
            ))}
          </InlineStack>
        )}

        {suggestedKeywords.length > 0 && (
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
              Suggested keywords. Click to add:
            </Text>

            <InlineStack gap="100" wrap>
              {suggestedKeywords.map((keyword) => (
                <Button
                  key={keyword}
                  size="slim"
                  onClick={() => onAddSuggestedKeyword(keyword)}
                  disabled={isSubmitting}
                >
                  {keyword}
                </Button>
              ))}
            </InlineStack>
          </BlockStack>
        )}

        {visibleKeywordResult?.ok === false && (
          <Banner tone="warning" title="Could not suggest keywords">
            {visibleKeywordResult.error ??
              "Please try again or enter keywords manually."}
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}

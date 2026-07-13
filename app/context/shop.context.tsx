import React, {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

interface ShopDisplayContextType {
  /**
   * Display-only shop domain.
   *
   * IMPORTANT:
   * Never use this value for:
   * - Authentication
   * - Authorization
   * - Shopify Admin API calls
   * - Prisma queries
   * - Billing
   * - Job ownership
   *
   * Always derive the authoritative shop from
   * requireAdminSession(request) in loaders/actions.
   */
  shopDomain: string;
}

const ShopDisplayContext =
  createContext<ShopDisplayContextType | null>(null);

interface ShopProviderProps {
  children: ReactNode;
  shopDomain: string;
}

const SHOP_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function ShopProvider({
  children,
  shopDomain,
}: ShopProviderProps) {
  // Validate the hydrated value
  if (!SHOP_DOMAIN_REGEX.test(shopDomain)) {
    console.warn(
      `Invalid Shopify shop domain passed to ShopProvider: "${shopDomain}"`
    );
  }

  // Memoize the context value
  const value = useMemo(
    () => ({
      shopDomain,
    }),
    [shopDomain],
  );

  return (
    <ShopDisplayContext.Provider value={value}>
      {children}
    </ShopDisplayContext.Provider>
  );
}

export function useShop() {
  const context = useContext(ShopDisplayContext);

  if (!context) {
    throw new Error("useShop must be used within ShopProvider");
  }

  return context;
}
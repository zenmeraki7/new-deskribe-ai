import React, { createContext, useContext } from "react";

interface ShopContextType {
  shopDomain: string;
}

const ShopContext = createContext<ShopContextType | null>(null);

export function ShopProvider({
  children,
  shopDomain,
}: {
  children: React.ReactNode;
  shopDomain: string;
}) {
  return (
    <ShopContext.Provider value={{ shopDomain }}>
      {children}
    </ShopContext.Provider>
  );
}

export function useShop() {
  const ctx = useContext(ShopContext);
  if (!ctx) {
    throw new Error("useShop must be used inside ShopProvider");
  }
  return ctx;
}
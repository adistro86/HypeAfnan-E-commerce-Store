"use client";

import React, { useState, useEffect, useCallback, useRef, Suspense } from "react";
import FilterBar from "./FilterBar";
import ProductGrid from "./ProductGrid";
import type { Product } from "./ProductGrid";

import { useSearchParams } from "next/navigation";

const PAGE_LIMIT = 300;

interface HomeClientProps {
  initialProducts: Product[];
  initialTotal: number;
}

// Isolated so useSearchParams()'s CSR bailout only skips THIS subtree during prerender —
// the server-rendered product grid stays in the static HTML for SEO.
function SearchParamSync({ onSearch }: { onSearch: (q: string) => void }) {
  const searchParams = useSearchParams();
  const searchQuery = searchParams.get("search") || "";

  useEffect(() => {
    if (!searchQuery) return;
    let active = true;
    // Delay fetch until after render so state is flushed
    const id = setTimeout(() => {
      if (active) onSearch(searchQuery);
    }, 0);
    return () => { active = false; clearTimeout(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, onSearch]);

  return null;
}

export default function HomeClient({ initialProducts, initialTotal }: HomeClientProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialProducts.length < initialTotal);
  const observerTarget = useRef<HTMLDivElement>(null);
  const isFetching = useRef(false);

  const fetchPage = useCallback(async (pageNum: number, category: string, reset = false, search = "") => {
    if (isFetching.current) return;
    isFetching.current = true;
    setLoading(true);
    try {
      const searchUrlParam = search ? `&search=${encodeURIComponent(search)}` : "";
      const res = await fetch(`/api/products?page=${pageNum}&limit=${PAGE_LIMIT}&category=${category}${searchUrlParam}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setProducts((prev) => (reset ? data.products : [...prev, ...data.products]));
      setTotal(data.total);
      setHasMore(pageNum < data.totalPages);
    } catch (e) {
      console.error("Error fetching products:", e);
    } finally {
      setLoading(false);
      isFetching.current = false;
    }
  }, []);

  // Called by SearchParamSync when the ?search= param changes (Header search)
  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    setPage(1);
    setProducts([]);
    fetchPage(1, activeCategory, true, q);
  }, [activeCategory, fetchPage]);

  const handleFilterChange = useCallback((filters: {
    category: string;
    viewMode: "grid" | "list";
    startDate: string;
    endDate: string;
    timeFrame: string;
    share: string;
  }) => {
    setViewMode(filters.viewMode);

    if (filters.category !== activeCategory) {
      setActiveCategory(filters.category);
      setPage(1);
      setProducts([]);
      fetchPage(1, filters.category, true);
    }
  }, [activeCategory, fetchPage]);

  // Infinite scroll: load next page when sentinel comes into view
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isFetching.current) {
          setPage((prev) => {
            const next = prev + 1;
            fetchPage(next, activeCategory, false, searchQuery);
            return next;
          });
        }
      },
      { threshold: 0.1 }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore, activeCategory, searchQuery, fetchPage]);

  return (
    <>
      <Suspense fallback={null}>
        <SearchParamSync onSearch={handleSearch} />
      </Suspense>
      <FilterBar onFilterChange={handleFilterChange} />
      <ProductGrid products={products} viewMode={viewMode} loading={loading} />

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={observerTarget} className="flex justify-center py-6">
          {loading && (
            <div className="flex items-center gap-2 text-gray-400">
              <svg
                className="animate-spin h-5 w-5 text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                {[...Array(12)].map((_, i) => (
                  <rect
                    key={i}
                    x="11"
                    y="2"
                    width="2"
                    height="5.5"
                    rx="1"
                    fill="currentColor"
                    transform={`rotate(${i * 30} 12 12)`}
                    opacity={0.1 + (i / 11) * 0.9}
                  />
                ))}
              </svg>
              <span className="text-[13px]">Loading...</span>
            </div>
          )}
        </div>
      )}

      {!hasMore && products.length > 0 && (
        <p className="text-center text-[12px] text-gray-400 pb-6">
          All {total.toLocaleString()} products loaded
        </p>
      )}
    </>
  );
}

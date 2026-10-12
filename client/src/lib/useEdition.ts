import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Edition } from "@shared/edition";

/** The server's edition from /api/health (public, no key). Unknown -> null. */
export function useEdition(): Edition | null {
  const { data } = useQuery<Edition | null>({
    queryKey: ["/api/health", "edition"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/health").catch(() => null);
      if (!r) return null;
      const j = await r.json().catch(() => null);
      return j?.edition === "investor" || j?.edition === "personal" ? j.edition : null;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  return data ?? null;
}

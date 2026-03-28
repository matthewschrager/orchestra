import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "./useApi";
import { filterFiles } from "../lib/fileFilter";

const CLIENT_CACHE_TTL_MS = 60_000;

interface FileAutocompleteState {
  fileSuggestions: string[];
  fileLoading: boolean;
  handleFileQueryChange: (query: string | null) => void;
}

/**
 * Hook for @-file autocomplete. Fetches the project's tracked file list once,
 * caches it client-side, and filters locally. Falls back to server-side search
 * for large (truncated) repos.
 */
export function useFileAutocomplete(activeProjectId: string | null): FileAutocompleteState {
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);

  // Track the project ID the cache belongs to
  const cachedProjectIdRef = useRef<string | null>(null);
  const fetchTimeRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  // Reset cache when project changes
  useEffect(() => {
    if (activeProjectId !== cachedProjectIdRef.current) {
      cachedProjectIdRef.current = activeProjectId;
      setAllFiles(null);
      setFilesTruncated(false);
      setFileSuggestions([]);
      fetchTimeRef.current = 0;
    }
  }, [activeProjectId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleFileQueryChange = useCallback(
    (query: string | null) => {
      // Clear debounce on every call
      if (debounceRef.current) clearTimeout(debounceRef.current);

      // No query or no project -> clear
      if (query === null || !activeProjectId) {
        setFileSuggestions([]);
        setFileLoading(false);
        return;
      }

      // Require at least 1 character after @
      if (query.length < 1) {
        setFileSuggestions([]);
        setFileLoading(false);
        return;
      }

      // Check if we need to fetch the file list
      const cacheStale = Date.now() - fetchTimeRef.current > CLIENT_CACHE_TTL_MS;
      const needsFetch = allFiles === null || cacheStale;

      if (needsFetch && !fileLoading) {
        // Fetch full file list
        setFileLoading(true);
        const fetchId = ++requestIdRef.current;

        api
          .getProjectFiles(activeProjectId)
          .then((result) => {
            // Stale check
            if (requestIdRef.current !== fetchId) return;
            if (cachedProjectIdRef.current !== activeProjectId) return;

            setAllFiles(result.files);
            setFilesTruncated(result.truncated);
            fetchTimeRef.current = Date.now();
            setFileLoading(false);

            // Filter with the current query using the fresh data
            if (result.truncated) {
              // For truncated repos, try local filter first
              const localResults = filterFiles(result.files, query);
              if (localResults.length > 0) {
                setFileSuggestions(localResults);
              } else {
                // Fall back to server search
                const searchId = ++requestIdRef.current;
                api.searchFiles(activeProjectId, query).then((searchResult) => {
                  if (requestIdRef.current === searchId) {
                    setFileSuggestions(searchResult.files);
                  }
                }).catch(() => {
                  if (requestIdRef.current === searchId) setFileSuggestions([]);
                });
              }
            } else {
              setFileSuggestions(filterFiles(result.files, query));
            }
          })
          .catch(() => {
            if (requestIdRef.current === fetchId) {
              setFileLoading(false);
              setFileSuggestions([]);
            }
          });
        return;
      }

      // We have cached files — filter locally or fall back to server
      if (allFiles && !filesTruncated) {
        // Local filtering (instant)
        setFileSuggestions(filterFiles(allFiles, query));
        return;
      }

      if (allFiles && filesTruncated) {
        // Try local first
        const localResults = filterFiles(allFiles, query);
        if (localResults.length > 0) {
          setFileSuggestions(localResults);
          return;
        }

        // Debounced server search for truncated repos
        setFileSuggestions([]);
        debounceRef.current = setTimeout(() => {
          const searchId = ++requestIdRef.current;
          api
            .searchFiles(activeProjectId, query)
            .then((result) => {
              if (requestIdRef.current === searchId) {
                setFileSuggestions(result.files);
              }
            })
            .catch(() => {
              if (requestIdRef.current === searchId) setFileSuggestions([]);
            });
        }, 150);
      }
    },
    [activeProjectId, allFiles, filesTruncated, fileLoading],
  );

  return { fileSuggestions, fileLoading, handleFileQueryChange };
}

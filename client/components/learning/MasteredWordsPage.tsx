import React, { useState, useEffect } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import { vh } from "@/client/lib/css";
import { fetchMasteredWords } from "@/client/api/words";
import type { WordWithLearnedCount } from "@/shared/types/api/words";

interface MasteredWordsPageProps {
  onBack: () => void;
}

export default function MasteredWordsPage({ onBack }: MasteredWordsPageProps) {
  const [words, setWords] = useState<WordWithLearnedCount[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  const PAGE_SIZE = 10;

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const data = await fetchMasteredWords(page * PAGE_SIZE, PAGE_SIZE);
      setWords(data.words || []);
      setTotal(data.total || 0);
      setLoading(false);
    };
    load();
  }, [page]);

  if (loading) {
    return (
      <Box
        sx={{
          minHeight: vh(1),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Typography>加载中...</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: vh(1),
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{
          px: 3,
          py: 2,
          borderBottom: "1px solid",
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          bgcolor: "background.paper",
        }}
      >
        <IconButton size="small" onClick={onBack}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h6" fontWeight={700} sx={{ ml: 2 }}>
          已学会单词
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ml: "auto" }}>
          共 {total} 个
        </Typography>
      </Box>

      <Box sx={{ flex: 1, p: 4, overflowY: "auto" }}>
        {words.length === 0 ? (
          <Typography sx={{ textAlign: "center", mt: 8 }}>
            还没有已学会的单词
          </Typography>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {words.map((word) => {
              const definitions = word.definition.split("；");
              return (
                <Card key={word.id} sx={{ borderRadius: 2 }}>
                  <CardContent sx={{ display: "flex", alignItems: "center" }}>
                    <Typography variant="h6" fontWeight={600} sx={{ flex: 1 }}>
                      {word.english}
                    </Typography>
                    <Box sx={{ flex: 2, px: 4 }}>
                      {definitions.map((def, idx) => (
                        <Typography
                          key={idx}
                          variant="body2"
                          color="text.secondary"
                          sx={{ textAlign: "left" }}
                        >
                          {def.trim()}
                        </Typography>
                      ))}
                    </Box>
                    <Typography
                      variant="body1"
                      color="success.main"
                      sx={{ fontWeight: 600 }}
                    >
                      {word.learned_count}次
                    </Typography>
                  </CardContent>
                </Card>
              );
            })}
          </Box>
        )}
      </Box>

      {total > PAGE_SIZE && (
        <Box
          sx={{
            p: 3,
            borderTop: "1px solid",
            borderColor: "divider",
            display: "flex",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <Button
            variant="contained"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <Typography variant="body2">
            {page + 1} / {Math.ceil(total / PAGE_SIZE)}
          </Typography>
          <Button
            variant="contained"
            disabled={page >= Math.ceil(total / PAGE_SIZE) - 1}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </Box>
      )}
    </Box>
  );
}

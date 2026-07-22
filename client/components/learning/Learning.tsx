import React, { useState, useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Switch from "@mui/material/Switch";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import { vh } from "@/client/lib/css";
import SelfDisciplineModal from "./SelfDisciplineModal";
import {
  fetchSelfDisciplineMode,
  fetchWordStats,
  updateSelfDisciplineMode,
} from "@/client/api/words";
import type { WordStats } from "@/shared/types/api/words";

interface LearningProps {
  onBack: () => void;
  onNavigate: (
    view: "word-learning" | "wrong-words" | "mastered-words",
  ) => void;
}

interface LearningCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
}

function LearningCard({ title, subtitle, onClick }: LearningCardProps) {
  return (
    <Card
      sx={{
        borderRadius: 2,
        cursor: "pointer",
        transition: "transform 0.2s, box-shadow 0.2s",
        "&:hover": {
          transform: "translateY(-4px)",
          boxShadow: 4,
        },
        "&:active": {
          transform: "translateY(-2px)",
        },
      }}
      onClick={onClick}
    >
      <CardContent sx={{ py: 4 }}>
        <Typography variant="h4" fontWeight={700} sx={{ mb: 2 }}>
          {title}
        </Typography>
        <Typography
          variant="body1"
          color="text.secondary"
          whiteSpace="pre-line"
        >
          {subtitle}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default function Learning({ onBack, onNavigate }: LearningProps) {
  const [selfDisciplineMode, setSelfDisciplineMode] = useState(false);
  const [showSelfDisciplineModal, setShowSelfDisciplineModal] = useState(false);
  const [stats, setStats] = useState<WordStats | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const timezoneOffset = -new Date().getTimezoneOffset();
    Promise.all([fetchWordStats(timezoneOffset), fetchSelfDisciplineMode()])
      .then(([statsData, disciplineData]) => {
        setStats(statsData.stats);
        setSelfDisciplineMode(disciplineData.enabled || false);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (selfDisciplineMode) {
      const scheduleNextQuiz = () => {
        timerRef.current = setTimeout(
          () => {
            setShowSelfDisciplineModal(true);
          },
          5 * 60 * 1000,
        );
      };

      scheduleNextQuiz();

      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      };
    } else if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, [selfDisciplineMode]);

  useEffect(() => {
    if (!showSelfDisciplineModal && selfDisciplineMode) {
      const scheduleNextQuiz = () => {
        timerRef.current = setTimeout(
          () => {
            setShowSelfDisciplineModal(true);
          },
          5 * 60 * 1000,
        );
      };

      scheduleNextQuiz();

      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      };
    }
  }, [showSelfDisciplineModal, selfDisciplineMode]);

  const handleSelfDisciplineChange = async (checked: boolean) => {
    setSelfDisciplineMode(checked);
    await updateSelfDisciplineMode(checked);
  };

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

  const totalWords = stats?.total || 3500;
  const learnedWords = stats?.learned || 0;
  const wrongWords = stats?.wrong || 0;
  const todayLearned = stats?.today_learned || 0;
  const unlearnedWords = totalWords - learnedWords;

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
          💪💪💪
        </Typography>
      </Box>

      <Box sx={{ flex: 1, p: 4, display: "flex", flexDirection: "column" }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 4,
            mb: 4,
          }}
        >
          <LearningCard
            title="背单词"
            subtitle={`当日已学习单词数：${todayLearned}\n未学习单词：${unlearnedWords}/${totalWords}`}
            onClick={() => onNavigate("word-learning")}
          />
          <LearningCard
            title="错题本"
            subtitle={`错题本单词数：${wrongWords}/${totalWords}`}
            onClick={() => onNavigate("wrong-words")}
          />
          <LearningCard
            title="已学会单词"
            subtitle={`已学会单词数：${learnedWords}/${totalWords}`}
            onClick={() => onNavigate("mastered-words")}
          />
        </Box>

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
            mt: "auto",
          }}
        >
          <Typography variant="body1">自律模式</Typography>
          <Switch
            checked={selfDisciplineMode}
            onChange={(e) => handleSelfDisciplineChange(e.target.checked)}
          />
        </Box>
      </Box>

      <SelfDisciplineModal
        open={showSelfDisciplineModal}
        onClose={() => setShowSelfDisciplineModal(false)}
      />
    </Box>
  );
}

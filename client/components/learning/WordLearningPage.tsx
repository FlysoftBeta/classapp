import React, { useState, useEffect, useCallback, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Switch from "@mui/material/Switch";
import { vh } from "@/client/lib/css";
import { fetchNextWord, recordWordPractice } from "@/client/api/words";
import type { Word } from "@/shared/types/api/words";

interface WordLearningPageProps {
  onBack: () => void;
  onProgress?: (stats: { total: number; correct: number }) => void;
}

function WordChoiceOption({
  text,
  isCorrect,
  isSelected,
  isHighlighted,
  onClick,
}: {
  text: string;
  isCorrect: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  onClick: () => void;
}) {
  let bgColor = "background.paper";
  let textColor = "text.primary";

  if (isSelected) {
    bgColor = isCorrect ? "success.light" : "error.light";
    textColor = isCorrect ? "success.main" : "error.main";
  } else if (isHighlighted && isCorrect) {
    bgColor = "success.light";
    textColor = "success.main";
  }

  return (
    <Button
      variant="contained"
      sx={{
        bgcolor: bgColor,
        color: textColor,
        width: "100%",
        height: 80,
        justifyContent: "flex-start",
        borderRadius: 2,
        textTransform: "none",
        fontSize: "1rem",
        border: "1px solid",
        borderColor: isHighlighted && isCorrect ? "success.main" : "divider",
      }}
      onClick={onClick}
      disabled={isSelected || isHighlighted}
    >
      {text}
    </Button>
  );
}

export default function WordLearningPage({
  onBack,
  onProgress,
}: WordLearningPageProps) {
  const [currentWord, setCurrentWord] = useState<Word | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [options, setOptions] = useState<
    { text: string; isCorrect: boolean; wordId: string }[]
  >([]);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [highlightedCorrect, setHighlightedCorrect] = useState(false);
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [sessionStats, setSessionStats] = useState({ total: 0, correct: 0 });
  const [wordIndex, setWordIndex] = useState(0);
  const [speedMode, setSpeedMode] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchNext = useCallback(async () => {
    const data = await fetchNextWord();
    if (data.word) {
      const options = [
        {
          text: data.word.definition,
          isCorrect: true,
          wordId: data.word.id,
        },
        ...(data.distractors || []).map((d) => ({
          text: d.definition,
          isCorrect: false,
          wordId: d.id,
        })),
      ];
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentWord(data.word);
        setOptions(options.sort(() => Math.random() - 0.5));
        setIsAnimating(false);
        setSelectedOption(null);
        setHighlightedCorrect(false);
        setWordIndex((prev) => prev + 1);
      }, 300);
    }
  }, []);

  const handlePractice = useCallback(
    async (correct: boolean, mastered = false) => {
      if (!currentWord) return;

      await recordWordPractice({
        wordId: currentWord.id,
        correct,
        mastered,
      });

      setSessionStats((prev) => ({
        total: prev.total + 1,
        correct: prev.correct + (correct ? 1 : 0),
      }));

      if (timerRef.current) clearTimeout(timerRef.current);
      setTimeout(fetchNext, 500);
    },
    [currentWord, fetchNext],
  );

  useEffect(() => {
    fetchNext();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchNext]);

  useEffect(() => {
    if (onProgress && sessionStats.total > 0) {
      onProgress(sessionStats);
    }
  }, [sessionStats, onProgress]);

  useEffect(() => {
    if (currentWord && speedMode) {
      timerRef.current = setTimeout(() => {
        setHighlightedCorrect(true);
        handlePractice(false, false);
      }, 5000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [currentWord, speedMode, handlePractice]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setSpeedMode(false);
        if (sessionStats.total > 0) {
          setShowExitDialog(true);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sessionStats.total]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (sessionStats.total > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [sessionStats.total]);

  const handleOptionClick = (index: number) => {
    if (selectedOption !== null) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    setSelectedOption(index);

    const isCorrect = options[index].isCorrect;
    setTimeout(() => {
      if (!isCorrect) {
        setHighlightedCorrect(true);
      }
      handlePractice(isCorrect, false);
    }, 800);
  };

  const handleExit = () => {
    setShowExitDialog(true);
  };

  const confirmExit = () => {
    setShowExitDialog(false);
    onBack();
  };

  const getExitMessage = () => {
    const { total, correct } = sessionStats;
    if (total === 0) return "本次学习你还没有开始学习单词哦~";
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
    if (accuracy === 100) {
      return `！？强强？！本次学习你学了${total}个单词，居然全部答对了！好吧我承认你很牛逼，只比原神差了一点点`;
    }
    return `你个肺雾😡才学了${total}个单词，居然连全对都做不到，仅仅只有${accuracy}%的正确率，你不配和神使用同一个暗网`;
  };

  if (!currentWord) {
    return (
      <Box
        sx={{
          minHeight: vh(1),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Typography>{isAnimating ? "加载中..." : "暂无单词"}</Typography>
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
        <IconButton size="small" onClick={handleExit}>
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography variant="h6" fontWeight={700} sx={{ ml: 2 }}>
          背单词
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ml: "auto" }}>
          {wordIndex} / ?
        </Typography>
        <Box sx={{ ml: 3, display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="body2" color="text.secondary" fontSize={12}>
            跟得上我的速度吗
          </Typography>
          <Switch
            checked={speedMode}
            onChange={(e) => setSpeedMode(e.target.checked)}
            size="small"
            color={speedMode ? "success" : "default"}
          />
        </Box>
      </Box>

      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          p: 4,
        }}
      >
        <Card sx={{ width: "100%", maxWidth: 500, mb: 6 }}>
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <Typography variant="h3" fontWeight={700}>
              {currentWord.english}
            </Typography>
            {currentWord.phonetic && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                {currentWord.phonetic}
              </Typography>
            )}
          </CardContent>
        </Card>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 2,
            width: "100%",
            maxWidth: 500,
          }}
        >
          {options.map((option, index) => (
            <WordChoiceOption
              key={index}
              text={option.text}
              isCorrect={option.isCorrect}
              isSelected={selectedOption === index}
              isHighlighted={highlightedCorrect}
              onClick={() => handleOptionClick(index)}
            />
          ))}
        </Box>
      </Box>

      <Dialog open={showExitDialog} onClose={() => setShowExitDialog(false)}>
        <DialogTitle>退出学习</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 4 }}>{getExitMessage()}</Typography>
          <Box sx={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
            <Button onClick={() => setShowExitDialog(false)}>继续学习</Button>
            <Button variant="contained" onClick={confirmExit}>
              确认退出
            </Button>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}

import React, { useState, useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import {
  fetchSelfDisciplineWord,
  recordWordPractice,
} from "@/client/api/words";
import type { Word } from "@/shared/types/api/words";

interface SelfDisciplineModalProps {
  open: boolean;
  onClose: () => void;
}

function WordChoiceOption({
  text,
  isCorrect,
  isSelected,
  onClick,
}: {
  text: string;
  isCorrect: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  let bgColor = "background.paper";
  let textColor = "text.primary";

  if (isSelected) {
    bgColor = isCorrect ? "success.light" : "error.light";
    textColor = isCorrect ? "success.main" : "error.main";
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
        borderColor: isSelected && isCorrect ? "success.main" : "divider",
      }}
      onClick={onClick}
      disabled={isSelected}
    >
      {text}
    </Button>
  );
}

export default function SelfDisciplineModal({
  open,
  onClose,
}: SelfDisciplineModalProps) {
  const [currentWord, setCurrentWord] = useState<Word | null>(null);
  const [options, setOptions] = useState<
    { text: string; isCorrect: boolean; wordId: string }[]
  >([]);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchWord = useRef(async () => {
    setLoading(true);
    const data = await fetchSelfDisciplineWord();
    if (data.word) {
      const distractors = data.distractors || [];
      const options = [
        {
          text: data.word.definition,
          isCorrect: true,
          wordId: data.word.id,
        },
        ...distractors.map((d) => ({
          text: d.definition,
          isCorrect: false,
          wordId: d.id,
        })),
      ];
      setCurrentWord(data.word);
      if (distractors.length > 0) {
        setOptions(options.sort(() => Math.random() - 0.5));
        setSelectedOption(null);
      }
    }
    setLoading(false);
  });

  useEffect(() => {
    if (open) {
      fetchWord.current();
    }
  }, [open]);

  const handleOptionClick = async (index: number) => {
    if (selectedOption !== null || !currentWord) return;
    setSelectedOption(index);

    const isCorrect = options[index].isCorrect;

    await recordWordPractice({
      wordId: currentWord.id,
      correct: isCorrect,
      mastered: false,
    });

    setTimeout(onClose, 500);
  };

  if (!open) return null;

  return (
    <Box
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        bgcolor: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        p: 4,
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 500 }}>
        <Typography
          variant="h5"
          fontWeight={700}
          textAlign="center"
          color="white"
          mb={4}
        >
          🧠 自律时刻 - 请答题
        </Typography>

        {loading ? (
          <Typography color="white" textAlign="center">
            加载中...
          </Typography>
        ) : currentWord ? (
          <>
            <Card sx={{ mb: 4 }}>
              <CardContent sx={{ textAlign: "center", py: 6 }}>
                <Typography variant="h3" fontWeight={700}>
                  {currentWord.english}
                </Typography>
              </CardContent>
            </Card>

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 2,
              }}
            >
              {options.map((option, index) => (
                <WordChoiceOption
                  key={index}
                  text={option.text}
                  isCorrect={option.isCorrect}
                  isSelected={selectedOption === index}
                  onClick={() => handleOptionClick(index)}
                />
              ))}
            </Box>
          </>
        ) : (
          <Typography color="white" textAlign="center">
            暂无单词
          </Typography>
        )}
      </Box>
    </Box>
  );
}

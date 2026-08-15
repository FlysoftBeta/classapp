import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  adminFetchAiBilling,
  adminUpdateAiBillingPolicy,
} from "@/client/api/admin";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import type { AiBillingSummary } from "@/shared/types/api";

function Metric({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" sx={{ mt: 0.5, fontWeight: 700 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {help}
      </Typography>
    </Paper>
  );
}

export function AiBillingTab() {
  const { data, loading, reload } = useActionQuery<AiBillingSummary>(
    adminFetchAiBilling,
    [],
  );
  const [dailyOverride, setDaily] = useState<string | null>(null);
  const [weeklyOverride, setWeekly] = useState<string | null>(null);
  const [durationOverride, setDuration] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");

  const daily = dailyOverride ?? String(data?.policy.daily_allowance ?? 100);
  const weekly = weeklyOverride ?? String(data?.policy.weekly_allowance ?? 300);
  const duration =
    durationOverride ?? String(data?.policy.default_plan_duration_days ?? 30);

  const save = async () => {
    const dailyAllowance = Number(daily);
    const weeklyAllowance = Number(weekly);
    const defaultPlanDurationDays = Number(duration);
    if (
      !Number.isFinite(dailyAllowance) ||
      dailyAllowance < 0 ||
      !Number.isFinite(weeklyAllowance) ||
      weeklyAllowance < 0 ||
      !Number.isSafeInteger(defaultPlanDurationDays) ||
      defaultPlanDurationDays <= 0
    ) {
      setFeedback("请输入有效的额度和套餐天数。");
      return;
    }
    setSaving(true);
    setFeedback("");
    try {
      await adminUpdateAiBillingPolicy({
        dailyAllowance,
        weeklyAllowance,
        defaultPlanDurationDays,
      });
      setFeedback("套餐策略已更新。现有有效套餐会使用新的额度标准。");
      setDaily(null);
      setWeekly(null);
      setDuration(null);
      reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <CircularProgress size={24} />;
  const maximum = Math.max(
    1,
    ...(data?.consumption_by_day.map((item) => item.credits) ?? []),
  );

  return (
    <Box sx={{ maxWidth: 1100 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 1.5,
          mb: 2.5,
        }}
      >
        <Metric
          label="系统内 credit 存量"
          value={`${data?.stock.total ?? 0}`}
          help="有效套餐的周额度与额外充值之和"
        />
        <Metric
          label="套餐周存量"
          value={`${data?.stock.weekly_plan ?? 0}`}
          help="按当前有效套餐聚合"
        />
        <Metric
          label="额外充值存量"
          value={`${data?.stock.top_up ?? 0}`}
          help="套餐额度耗尽后继续使用"
        />
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2.5 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          统一套餐策略
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          日、周两个独立会计窗口共同限制套餐消耗，不对周末作特殊处理。套餐天数用于新分配，重新分配用户套餐时可单独指定。
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: 1.5,
            mt: 2,
            alignItems: "start",
          }}
        >
          <TextField
            label="每日 credits"
            type="number"
            size="small"
            value={daily}
            onChange={(event) => setDaily(event.target.value)}
          />
          <TextField
            label="每周 credits"
            type="number"
            size="small"
            value={weekly}
            onChange={(event) => setWeekly(event.target.value)}
          />
          <TextField
            label="默认套餐天数"
            type="number"
            size="small"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
          <Button
            variant="contained"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? (
              <CircularProgress size={18} color="inherit" />
            ) : (
              "保存策略"
            )}
          </Button>
        </Box>
        {feedback ? (
          <Alert
            severity={
              feedback.includes("失败") ||
              feedback.includes("有效") ||
              feedback.includes("不能")
                ? "error"
                : "success"
            }
            sx={{ mt: 2 }}
          >
            {feedback}
          </Alert>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          最近 30 天实际消耗
        </Typography>
        <Box sx={{ display: "grid", gap: 0.75, mt: 1.5 }}>
          {data?.consumption_by_day.length ? (
            data.consumption_by_day.map((item) => (
              <Box
                key={item.date}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 90px",
                  gap: 1,
                  alignItems: "center",
                }}
              >
                <Typography variant="caption">{item.date.slice(5)}</Typography>
                <Box
                  sx={{
                    height: 8,
                    borderRadius: 4,
                    bgcolor: "action.hover",
                    overflow: "hidden",
                  }}
                >
                  <Box
                    sx={{
                      height: "100%",
                      width: `${(item.credits / maximum) * 100}%`,
                      bgcolor: "primary.main",
                    }}
                  />
                </Box>
                <Typography variant="caption" textAlign="right">
                  {item.credits} credits
                </Typography>
              </Box>
            ))
          ) : (
            <Typography variant="body2" color="text.secondary">
              暂无已结算消耗。
            </Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
}

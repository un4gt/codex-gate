import { useI18n,type Locale } from "@/lib/i18n";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";

const LOCALES: Locale[] = ["zh", "en"];

export function LocaleSwitch() {
  const { t, locale, setLocale, isSwitching } = useI18n();

  return (
    <Box
      sx={{
        display: "inline-flex",
        maxWidth: "100%",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.25rem",
        borderRadius: "8px",
        borderStyle: "solid",
        borderWidth: "1px",
        borderColor: "var(--mui-palette-divider)",
        backgroundColor:
          "color-mix(in oklab, var(--mui-palette-action-hover) 50%, transparent)",
        padding: "0.25rem",
      }}
      role="group"
      aria-label={t("切换语言")}
    >
      {LOCALES.map((item) => (
        <Button
          key={item}
          type="button"
          size="small"
          variant="text"
          aria-pressed={locale === item}
          sx={{
            ...{
              height: "1.75rem",
              paddingInline: "0.5rem",
              fontSize: "0.75rem",
              lineHeight: "calc(1 / 0.75)",
            },
            ...(locale === item
              ? {
                  backgroundColor: "var(--mui-palette-background-paper)",
                  color: "var(--mui-palette-primary-main)",
                  boxShadow: "none",
                }
              : { color: "var(--mui-palette-text-secondary)" }),
            ...{},
          }}
          onClick={() => setLocale(item)}
          disabled={isSwitching && locale !== item}
          title={item === "zh" ? t("切换到中文") : t("Switch to English")}
        >
          {item === "zh" ? "ZH" : "EN"}
        </Button>
      ))}
    </Box>
  );
}

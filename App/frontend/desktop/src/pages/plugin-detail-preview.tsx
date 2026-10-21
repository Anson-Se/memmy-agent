import { BarChart3, BookOpen, FileCheck2, FileText, FolderOpen, ListChecks, ListTree, Presentation, Quote, Scale, Sparkles } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import "./plugin-detail-preview.css";

export interface PluginDetailPreviewProps {
  category: "legal" | "research" | "office" | "other";
  name: string;
}

const previewExamples = {
  research: {
    icon: BookOpen,
    prompts: [
      { icon: FileText, zh: "生成一篇关于 AI Memory 的文献综述", en: "Generate a literature review on AI Memory" },
      { icon: ListTree, zh: "为这组论文整理文献综述大纲", en: "Outline a literature review from these papers" },
      { icon: Quote, zh: "检查综述草稿，标出需要补充引用的段落", en: "Mark passages in my draft that need citations" }
    ]
  },
  office: {
    icon: Presentation,
    prompts: [
      { icon: FileText, zh: "把这份会议纪要整理成 Word 文档", en: "Turn these meeting notes into a Word document" },
      { icon: BarChart3, zh: "根据这份表格生成图表和数据摘要", en: "Create charts and a summary from this spreadsheet" },
      { icon: Presentation, zh: "将这份项目计划整理成 PPT 初稿", en: "Turn this project plan into a draft slide deck" }
    ]
  },
  legal: {
    icon: Scale,
    prompts: [
      { icon: FolderOpen, zh: "整理这批劳动用工调研材料", en: "Organize these employment research materials" },
      { icon: ListChecks, zh: "根据现有材料列出待核实的访谈问题", en: "Draft interview questions to verify the information" },
      { icon: FileCheck2, zh: "生成一份供律师复核的报告草稿", en: "Prepare a report draft for a lawyer to review" }
    ]
  },
  other: {
    icon: Sparkles,
    prompts: [
      { icon: FileText, zh: "整理这份材料，列出关键要点", en: "Organize this material and list its key points" },
      { icon: ListChecks, zh: "根据这个目标，整理接下来的步骤", en: "Outline the next steps toward this goal" },
      { icon: Sparkles, zh: "根据我的要求，准备一份可修改的初稿", en: "Prepare an editable first draft from my instructions" }
    ]
  }
} as const;

/** A static introduction visual. Examples do not submit prompts or start tasks. */
export function PluginDetailPreview(props: PluginDetailPreviewProps) {
  const { language } = useTranslation();
  const zh = language === "zh-CN";
  const config = previewExamples[props.category];
  const AmbientIcon = config.icon;

  return (
    <figure className={`plugin-detail-preview plugin-detail-preview--${props.category}`}
      aria-label={zh ? "使用示例" : "Usage examples"}>
      <figcaption className="plugin-detail-preview-caption">
        {zh ? `${props.name}的使用示例` : `Examples of using ${props.name}`}
      </figcaption>
      <div className="plugin-detail-preview-ambient" aria-hidden="true">
        <span className="plugin-detail-preview-orbit" />
        <AmbientIcon className="plugin-detail-preview-ambient-icon" strokeWidth={1.2} />
        <Sparkles className="plugin-detail-preview-sparkles" strokeWidth={1.3} />
      </div>
      <ul className="plugin-detail-preview-examples">
        {config.prompts.map((prompt) => {
          const Icon = prompt.icon;
          return (
            <li key={prompt.en} className="plugin-detail-preview-example">
              <Icon className="plugin-detail-preview-example-icon" strokeWidth={1.6} aria-hidden="true" />
              <span className="plugin-detail-preview-example-text">{zh ? prompt.zh : prompt.en}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

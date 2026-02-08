declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  interface TerminalRendererOptions {
    code?: (code: string) => string;
    blockquote?: (quote: string) => string;
    html?: (html: string) => string;
    heading?: (text: string, level: number) => string;
    firstHeading?: (text: string, level: number) => string;
    hr?: () => string;
    list?: (body: string, ordered: boolean) => string;
    listitem?: (text: string) => string;
    paragraph?: (text: string) => string;
    table?: (header: string, body: string) => string;
    tablerow?: (content: string) => string;
    tablecell?: (content: string, flags: object) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (code: string) => string;
    del?: (text: string) => string;
    link?: (href: string, title: string, text: string) => string;
    href?: (href: string) => string;
    image?: (href: string, title: string, text: string) => string;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    width?: number;
    tab?: number;
  }

  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: object
  ): MarkedExtension;

  export default class Renderer {
    constructor(options?: TerminalRendererOptions, highlightOptions?: object);
  }
}

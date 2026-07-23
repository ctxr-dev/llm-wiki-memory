import type { NavChildren } from "./api";

type Dir = NavChildren["dirs"][number];
type Doc = NavChildren["docs"][number];

export type NavItem = ({ kind: "dir" } & Dir) | ({ kind: "doc" } & Doc);

export function navItems(children: NavChildren | undefined): NavItem[] {
  if (!children) return [];
  return [
    ...children.dirs.map((dir) => ({ kind: "dir" as const, ...dir })),
    ...children.docs.map((doc) => ({ kind: "doc" as const, ...doc })),
  ];
}

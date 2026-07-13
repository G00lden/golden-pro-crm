export type DepartmentDeletionTarget = Readonly<{
  id: string;
  name: string;
  digit: string;
}>;

export type DepartmentDeletionResult = "deleted" | "dismissed" | "ignored";

type DepartmentDeletionDependencies = {
  confirm: (message: string) => boolean;
  remove: (departmentId: string) => Promise<void>;
  onPendingChange?: (departmentId: string | null) => void;
};

export function buildDepartmentDeletionMessage(department: DepartmentDeletionTarget): string {
  return [
    `هل تريد حذف قسم «${department.name}» (الاختيار ${department.digit})؟`,
    "سيُحذف مسار التحويل والموظفون المرتبطون بهذا القسم، ولا يمكن التراجع عن هذا الإجراء.",
  ].join("\n\n");
}

/**
 * Keeps the destructive action serialised. The in-flight marker is assigned
 * synchronously after confirmation, so a second click cannot issue another
 * DELETE request while React is still waiting to render the disabled state.
 */
export function createDepartmentDeletionController(
  dependencies: DepartmentDeletionDependencies,
) {
  let pendingDepartmentId: string | null = null;

  return {
    getPendingDepartmentId: () => pendingDepartmentId,

    async request(department: DepartmentDeletionTarget): Promise<DepartmentDeletionResult> {
      if (pendingDepartmentId !== null) return "ignored";
      if (!dependencies.confirm(buildDepartmentDeletionMessage(department))) return "dismissed";

      pendingDepartmentId = department.id;
      try {
        dependencies.onPendingChange?.(department.id);
        await dependencies.remove(department.id);
        return "deleted";
      } finally {
        pendingDepartmentId = null;
        dependencies.onPendingChange?.(null);
      }
    },
  };
}

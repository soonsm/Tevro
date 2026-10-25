// 서버 API(/api/v1)의 요청·응답 모양. 웹과 CLI가 같은 타입을 쓴다.
import type { Edge, Summary, TaskStatus } from './domain.ts';

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  jiraUrl: string | null;
  /** jiraUrl에서 꺼낸 이슈 키. 저장하지 않고 응답할 때 계산한다. */
  jiraKey: string | null;
  confluenceUrl: string | null;
  predecessorIds: string[];
  successorIds: string[];
  unmetPrerequisiteIds: string[];
  prerequisitesMet: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DependencyDto = Edge;

export interface GraphDto {
  project: ProjectDto;
  tasks: TaskDto[];
  dependencies: DependencyDto[];
  summary: Summary;
}

export interface DeleteTaskResult {
  deletedTaskId: string;
  removedDependencies: DependencyDto[];
}

/** 공정을 만들거나 고칠 때 보내는 값. 링크는 빈 문자열이나 null을 보내면 지운다. */
export interface TaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  jiraUrl?: string | null;
  confluenceUrl?: string | null;
}

export type ErrorCode =
  | 'VALIDATION_INPUT'
  | 'VALIDATION_SELF_LOOP'
  | 'VALIDATION_DUPLICATE_EDGE'
  | 'VALIDATION_CYCLE'
  | 'REFERENCE_NOT_FOUND'
  | 'CROSS_PROJECT_REFERENCE'
  | 'NOT_FOUND'
  | 'INTERNAL';

/** 오류 응답(application/problem+json). 순환 오류면 cycle에 공정 ID 경로가 들어 있다. */
export interface Problem {
  status: number;
  code: ErrorCode;
  title: string;
  detail: string;
  cycle?: string[];
}

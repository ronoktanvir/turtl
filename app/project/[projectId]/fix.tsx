import { useLocalSearchParams } from "expo-router";
import BeginScreen from "../../../components/project/BeginScreen";
import NothingOpen from "../../../components/project/NothingOpen";
import { useCases, useProject } from "../../../data";

export default function Fix() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const cases = useCases(projectId, "fix");
  return project && cases?.length === 0 ? <NothingOpen type="fix" projectId={projectId} /> : <BeginScreen type="fix" />;
}

import { useLocalSearchParams } from "expo-router";
import BeginScreen from "../../../components/project/BeginScreen";
import NothingOpen from "../../../components/project/NothingOpen";
import { useCases, useProject } from "../../../data";

export default function Features() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const cases = useCases(projectId, "feature");
  return project && cases?.length === 0 ? <NothingOpen type="feature" projectId={projectId} /> : <BeginScreen type="feature" />;
}

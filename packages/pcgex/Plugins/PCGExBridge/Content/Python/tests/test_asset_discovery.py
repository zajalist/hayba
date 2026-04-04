import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

class TestAssetPathParsing(unittest.TestCase):
    """Test asset path and tag extraction logic."""

    def test_extract_tags_from_example_path(self):
        """Tags should be extracted from the content path."""
        from pcgex_exporter import _extract_tags_from_path
        path = "/Game/PCGExExampleProject/Examples/ForestPaths.ForestPaths"
        tags = _extract_tags_from_path(path)
        self.assertNotIn("examples", tags)
        self.assertIn("forestpaths", tags)

    def test_extract_tags_from_category_path(self):
        """Category paths should produce appropriate tags."""
        from pcgex_exporter import _extract_tags_from_path
        path = "/Game/PCGExExampleProject/Categories/Clustering/ClusterTest.ClusterTest"
        tags = _extract_tags_from_path(path)
        self.assertNotIn("categories", tags)
        self.assertIn("clustering", tags)
        self.assertIn("clustertest", tags)

    def test_make_safe_filename(self):
        """Asset names should become safe filenames."""
        from pcgex_exporter import _make_safe_filename
        self.assertEqual(_make_safe_filename("Forest Paths"), "Forest_Paths")
        self.assertEqual(_make_safe_filename("Test-Graph_v2"), "Test-Graph_v2")
        self.assertEqual(_make_safe_filename("My/Weird:Name"), "My_Weird_Name")
        self.assertEqual(_make_safe_filename(""), "unnamed_graph")

    def test_sanitize_primitives(self):
        """Sanitize helpers should handle primitive types correctly."""
        from pcgex_exporter import _sanitize_property_value

        result = _sanitize_property_value(42)
        self.assertEqual(result, 42)

        result = _sanitize_property_value(True)
        self.assertEqual(result, True)

        result = _sanitize_property_value("test")
        self.assertEqual(result, "test")

        result = _sanitize_property_value([1, 2, 3])
        self.assertEqual(result, [1, 2, 3])

    def test_sanitize_vector(self):
        """Vector values should be converted to dicts."""
        from pcgex_exporter import _sanitize_property_value
        # Test with a mock object that has x, y, z
        class MockVector:
            def __init__(self):
                self.x = 1.0
                self.y = 2.0
                self.z = 3.0
        result = _sanitize_property_value(MockVector())
        self.assertEqual(result, {"x": 1.0, "y": 2.0, "z": 3.0})

    def test_sanitize_vector2d(self):
        """2D vector values should be converted to dicts."""
        from pcgex_exporter import _sanitize_property_value
        class MockVector2D:
            def __init__(self):
                self.x = 5.0
                self.y = 10.0
        result = _sanitize_property_value(MockVector2D())
        self.assertEqual(result, {"x": 5.0, "y": 10.0})

    def test_sanitize_rotator(self):
        """Rotator values should be converted to dicts."""
        from pcgex_exporter import _sanitize_property_value
        class MockRotator:
            def __init__(self):
                self.pitch = 45.0
                self.yaw = 90.0
                self.roll = 0.0
        result = _sanitize_property_value(MockRotator())
        self.assertEqual(result, {"pitch": 45.0, "yaw": 90.0, "roll": 0.0})

if __name__ == "__main__":
    unittest.main()

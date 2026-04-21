"""Optimization modules for the recommendation engine."""
from anvx_core.intelligence.optimization.base_module import OptimizationModule
from anvx_core.intelligence.optimization.model_routing import ModelRoutingModule
from anvx_core.intelligence.optimization.caching_estimator import CachingEstimatorModule
from anvx_core.intelligence.optimization.batch_detector import BatchDetectorModule
from anvx_core.intelligence.optimization.unit_economics import UnitEconomicsModule
from anvx_core.intelligence.optimization.price_comparison import PriceComparisonModule
from anvx_core.intelligence.optimization.spend_forecast import SpendForecastModule

ALL_MODULES: list[type[OptimizationModule]] = [
    ModelRoutingModule,
    CachingEstimatorModule,
    BatchDetectorModule,
    UnitEconomicsModule,
    PriceComparisonModule,
    SpendForecastModule,
]

__all__ = [
    "OptimizationModule",
    "ALL_MODULES",
    "ModelRoutingModule",
    "CachingEstimatorModule",
    "BatchDetectorModule",
    "UnitEconomicsModule",
    "PriceComparisonModule",
    "SpendForecastModule",
]
